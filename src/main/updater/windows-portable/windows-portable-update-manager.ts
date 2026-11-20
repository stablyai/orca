import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { app, net } from 'electron'
import { runProcess } from '@orca/process-host'
import { spawnDetachedWithoutInheritance } from '@orca/process-host/isolated-detached-spawn'
import { extractWindowsPortableArchive } from './windows-portable-archive'
import {
  getWindowsPortableAssetUrls,
  isWindowsPortableInstall,
  parseSha256ChecksumFile,
  resolveBundledPortableUpdaterPath,
  WINDOWS_PORTABLE_ARCHIVE_NAME,
  WINDOWS_PORTABLE_DATA_DIR,
  WINDOWS_PORTABLE_PUBLISHER,
  WINDOWS_PORTABLE_REQUIRED_SIGNED_EXECUTABLES
} from './windows-portable-package'
import type { ElectronAutoUpdater } from '../electron-updater-loader'

const BACKUP_DIR_NAME = 'portable-backup'
const PORTABLE_UPDATE_WORK_DIR = '.portable-update'
const SIGNATURE_CHECK_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

export type StagedWindowsPortableUpdate = {
  version: string
  targetDir: string
  workDir: string
  stagedDir: string
  helperCopyPath: string
}

let stagedUpdate: StagedWindowsPortableUpdate | null = null

export function getStagedWindowsPortableUpdate(): StagedWindowsPortableUpdate | null {
  return stagedUpdate
}

export function clearStagedWindowsPortableUpdate(): void {
  stagedUpdate = null
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function downloadFileWithProgress(
  url: string,
  destinationPath: string,
  onProgress: (percent: number) => void
): Promise<string> {
  const response = await net.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok || !response.body) {
    throw new Error(`Could not download portable update archive (HTTP ${response.status})`)
  }
  const totalBytes = Number(response.headers.get('content-length') ?? 0)
  const hash = createHash('sha256')
  const fileHandle = await open(destinationPath, 'w')
  let receivedBytes = 0
  let lastPercent = -1

  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      const chunk = Buffer.from(value)
      hash.update(chunk)
      await fileHandle.write(chunk)
      receivedBytes += chunk.length
      if (totalBytes > 0) {
        const percent = Math.min(99, Math.round((receivedBytes / totalBytes) * 100))
        if (percent !== lastPercent) {
          lastPercent = percent
          onProgress(percent)
        }
      }
    }
    return hash.digest('hex')
  } finally {
    await fileHandle.close()
  }
}

async function verifyStagedExecutables(
  updaterBinary: string,
  stagedDir: string,
  expectedPublisher: string
): Promise<void> {
  for (const relativeExecutable of WINDOWS_PORTABLE_REQUIRED_SIGNED_EXECUTABLES) {
    const candidatePath = join(stagedDir, ...relativeExecutable.split('/'))
    const result = await runProcess({
      program: updaterBinary,
      args: ['verify-signature', candidatePath, '--publisher', expectedPublisher],
      timeoutMs: SIGNATURE_CHECK_TIMEOUT_MS
    })
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || '').trim()
      throw new Error(
        detail || `Signature verification failed for portable update binary: ${relativeExecutable}`
      )
    }
  }
}

export async function downloadAndStageWindowsPortableUpdate(options: {
  version: string
  onProgress: (percent: number) => void
  expectedPublisher?: string
}): Promise<StagedWindowsPortableUpdate> {
  const targetDir = win32.dirname(process.execPath)
  // Stage under data/.portable-update so rename stays same-volume and O(1) even on external drives.
  const workDir = join(targetDir, WINDOWS_PORTABLE_DATA_DIR, PORTABLE_UPDATE_WORK_DIR)
  const backupDir = join(workDir, BACKUP_DIR_NAME)
  if (await pathExists(backupDir)) {
    throw new Error(
      `Previous portable update recovery backup exists at ${backupDir}. Resolve it before updating.`
    )
  }

  const updaterBinary = resolveBundledPortableUpdaterPath(process.resourcesPath)
  if (!(await pathExists(updaterBinary))) {
    throw new Error('Bundled Windows portable updater binary is missing.')
  }

  const { archiveUrl, sha256Url } = getWindowsPortableAssetUrls(options.version)
  const shaRes = await net.fetch(sha256Url, { signal: AbortSignal.timeout(30_000) })
  if (!shaRes.ok) {
    throw new Error(`Could not download portable update checksum (HTTP ${shaRes.status})`)
  }
  const expectedSha256 = parseSha256ChecksumFile(
    await shaRes.text(),
    WINDOWS_PORTABLE_ARCHIVE_NAME
  )

  const archivePath = join(workDir, 'download.zip')
  const stagedDir = join(workDir, 'staged')
  await mkdir(workDir, { recursive: true })
  await rm(archivePath, { force: true })
  await rm(stagedDir, { recursive: true, force: true })

  try {
    const actualSha256 = await downloadFileWithProgress(archiveUrl, archivePath, options.onProgress)
    if (actualSha256 !== expectedSha256) {
      throw new Error('Portable update archive SHA-256 verification failed.')
    }

    await extractWindowsPortableArchive(archivePath, stagedDir)
    await verifyStagedExecutables(
      updaterBinary,
      stagedDir,
      options.expectedPublisher ?? WINDOWS_PORTABLE_PUBLISHER
    )
  } catch (error) {
    await rm(archivePath, { force: true }).catch(() => {})
    await rm(stagedDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  await rm(archivePath, { force: true }).catch(() => {})
  // Copy helper outside targetDir so the running helper cannot lock any file being replaced.
  const helperCopyPath = join(tmpdir(), `orca-portable-updater-${process.pid}-${Date.now()}.exe`)
  await copyFile(updaterBinary, helperCopyPath)

  stagedUpdate = {
    version: options.version,
    targetDir,
    workDir,
    stagedDir,
    helperCopyPath
  }
  options.onProgress(100)
  return stagedUpdate
}

export function launchStagedWindowsPortableUpdate(relaunch: boolean): void {
  const staged = stagedUpdate
  if (!staged) {
    throw new Error('No staged Windows portable update is ready to install.')
  }
  const args = [
    'apply',
    '--parent-pid',
    String(process.pid),
    '--staged',
    staged.stagedDir,
    '--target',
    staged.targetDir,
    '--work',
    staged.workDir,
    ...(relaunch ? ['--relaunch'] : [])
  ]
  const child = spawnDetachedWithoutInheritance({
    program: staged.helperCopyPath,
    args,
    cwd: staged.workDir
  })
  child.unref()
  stagedUpdate = null
  // Match electron-updater: quit on next tick so post-invoke session release and exit watchdog run first.
  setImmediate(() => {
    app.quit()
  })
}

export function invokeQuitAndInstallForCurrentPackage(
  autoUpdater: ElectronAutoUpdater,
  automatic: boolean,
  supervisorOwnsRelaunch: boolean
): void {
  if (isWindowsPortableInstall()) {
    launchStagedWindowsPortableUpdate(!supervisorOwnsRelaunch)
    return
  }
  autoUpdater.quitAndInstall(automatic || supervisorOwnsRelaunch, !supervisorOwnsRelaunch)
}
