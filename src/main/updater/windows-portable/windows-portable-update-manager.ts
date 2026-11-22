import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
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

const PORTABLE_UPDATE_WORK_DIR = '.portable-update'
const STAGED_MANIFEST_FILE = 'staged-manifest.txt'
const STAGE_RESERVATION_LOCK_FILE = 'portable-staging.lock'
const SIGNATURE_CHECK_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

export type StagedWindowsPortableUpdate = {
  version: string
  targetDir: string
  workDir: string
  stagedDir: string
  manifestPath: string
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

async function buildStagedManifestLines(
  rootDir: string,
  currentDir: string,
  prefix = ''
): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true })
  const lines: string[] = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const relLower = rel.toLowerCase()
    if (relLower === WINDOWS_PORTABLE_DATA_DIR || relLower.startsWith(`${WINDOWS_PORTABLE_DATA_DIR}/`)) {
      continue
    }
    const fullPath = join(currentDir, entry.name)
    if (entry.isDirectory()) {
      lines.push(...(await buildStagedManifestLines(rootDir, fullPath, rel)))
    } else if (entry.isFile()) {
      const info = await stat(fullPath)
      lines.push(`${info.size}\t${relLower}`)
    }
  }
  return lines
}

export async function downloadAndStageWindowsPortableUpdate(options: {
  version: string
  onProgress: (percent: number) => void
  expectedPublisher?: string
}): Promise<StagedWindowsPortableUpdate> {
  const targetDir = win32.dirname(process.execPath)
  const workDir = join(targetDir, WINDOWS_PORTABLE_DATA_DIR, PORTABLE_UPDATE_WORK_DIR)
  const updaterBinary = resolveBundledPortableUpdaterPath(process.resourcesPath)
  if (!(await pathExists(updaterBinary))) {
    throw new Error('Bundled Windows portable updater binary is missing.')
  }

  await mkdir(workDir, { recursive: true })
  const stageLockPath = join(workDir, STAGE_RESERVATION_LOCK_FILE)
  const stageLock = await open(stageLockPath, 'wx').catch(() => {
    throw new Error('Another portable update staging or installation is already in progress.')
  })

  try {
    const recoverResult = await runProcess({
      program: updaterBinary,
      args: ['recover', '--target', targetDir, '--work', workDir],
      timeoutMs: SIGNATURE_CHECK_TIMEOUT_MS
    })
    if (recoverResult.code !== 0) {
      const detail = (recoverResult.stderr || recoverResult.stdout || '').trim()
      throw new Error(detail || 'Previous portable update state could not be reconciled.')
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
    const manifestPath = join(workDir, STAGED_MANIFEST_FILE)
    clearStagedWindowsPortableUpdate()
    await rm(archivePath, { force: true })
    await rm(stagedDir, { recursive: true, force: true })
    await rm(manifestPath, { force: true })

    try {
      const actualSha256 = await downloadFileWithProgress(
        archiveUrl,
        archivePath,
        options.onProgress
      )
      if (actualSha256 !== expectedSha256) {
        throw new Error('Portable update archive SHA-256 verification failed.')
      }

      await extractWindowsPortableArchive(archivePath, stagedDir)
      await verifyStagedExecutables(
        updaterBinary,
        stagedDir,
        options.expectedPublisher ?? WINDOWS_PORTABLE_PUBLISHER
      )
      const manifestLines = (await buildStagedManifestLines(stagedDir, stagedDir)).sort()
      await writeFile(manifestPath, `${manifestLines.join('\n')}\n`, 'utf8')
    } catch (error) {
      await rm(archivePath, { force: true }).catch(() => {})
      await rm(stagedDir, { recursive: true, force: true }).catch(() => {})
      await rm(manifestPath, { force: true }).catch(() => {})
      throw error
    }

    await rm(archivePath, { force: true }).catch(() => {})
    const helperCopyPath = join(tmpdir(), `orca-portable-updater-${process.pid}-${Date.now()}.exe`)
    await copyFile(updaterBinary, helperCopyPath)

    stagedUpdate = {
      version: options.version,
      targetDir,
      workDir,
      stagedDir,
      manifestPath,
      helperCopyPath
    }
    options.onProgress(100)
    return stagedUpdate
  } finally {
    await stageLock.close().catch(() => {})
    await rm(stageLockPath, { force: true }).catch(() => {})
  }
}

export async function launchStagedWindowsPortableUpdate(relaunch: boolean): Promise<void> {
  const staged = stagedUpdate
  if (!staged) {
    throw new Error('No staged Windows portable update is ready to install.')
  }
  const explicitUserDataDir = app.commandLine.hasSwitch('user-data-dir')
    ? app.getPath('userData')
    : null
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
    '--manifest',
    staged.manifestPath,
    ...(explicitUserDataDir ? ['--user-data-dir', explicitUserDataDir] : []),
    ...(relaunch ? ['--relaunch'] : [])
  ]

  await new Promise<void>((resolve, reject) => {
    const child = spawnDetachedWithoutInheritance({
      program: staged.helperCopyPath,
      args,
      cwd: staged.workDir
    })
    const onError = (error: Error): void => {
      reject(error)
    }
    child.once('error', onError)
    if (child.pid !== undefined) {
      child.removeListener('error', onError)
      child.unref()
      resolve()
      return
    }
    child.once('spawn', () => {
      child.removeListener('error', onError)
      child.unref()
      resolve()
    })
  })

  stagedUpdate = null
  setImmediate(() => {
    app.quit()
  })
}

export async function invokeQuitAndInstallForCurrentPackage(
  autoUpdater: ElectronAutoUpdater,
  automatic: boolean,
  supervisorOwnsRelaunch: boolean
): Promise<void> {
  if (isWindowsPortableInstall()) {
    await launchStagedWindowsPortableUpdate(!supervisorOwnsRelaunch)
    return
  }
  autoUpdater.quitAndInstall(automatic || supervisorOwnsRelaunch, !supervisorOwnsRelaunch)
}
