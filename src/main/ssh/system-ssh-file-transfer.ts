import { spawn } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { join as pathJoin } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { SshTarget } from '../../shared/ssh-types'
import { shellEscape, wrapRemoteCommandForPosixShell } from './ssh-connection-utils'
import { findSystemSsh } from './system-ssh-binary'
import {
  buildSshArgs,
  getSystemSshBuildArgsFromOperationOptions,
  type SystemSshBuildArgsOptions
} from './system-ssh-args'
import { spawnSystemSshCommand } from './system-ssh-command'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand } from './ssh-remote-powershell'
import {
  awaitWithSystemSshAbort,
  killProcess,
  throwIfAborted,
  waitForChannelClose,
  waitForProcess,
  type ProcessResult
} from './system-ssh-operation-lifecycle'
import {
  uploadFileViaSystemSsh,
  WINDOWS_STDIN_WRITE_CHUNK_BYTES,
  WINDOWS_STDIN_WRITE_TIMEOUT_MS,
  writeBufferViaSystemSsh
} from './system-ssh-file-binary-transfer'

type SystemSshOperationOptions = SystemSshBuildArgsOptions & {
  signal?: AbortSignal
  hostPlatform?: RemoteHostPlatform
}

export async function uploadDirectoryViaSystemSsh(
  target: SshTarget,
  localDir: string,
  remoteDir: string,
  options?: SystemSshOperationOptions
): Promise<void> {
  throwIfAborted(options?.signal)
  if (options?.hostPlatform && isWindowsRemoteHost(options.hostPlatform)) {
    await uploadDirectoryViaSystemSshWindows(target, localDir, remoteDir, options)
    return
  }

  const sshPath = findSystemSsh()
  if (!sshPath) {
    throw new Error('No system ssh binary found. Install OpenSSH to use system SSH transport.')
  }

  const tarCreate = spawn('tar', ['-czf', '-', '-C', localDir, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const remoteCommand = `mkdir -p ${shellEscape(remoteDir)} && tar -xzf - -C ${shellEscape(remoteDir)}`
  const sshExtract = spawn(
    sshPath,
    [...buildSshArgs(target, options), wrapRemoteCommandForPosixShell(remoteCommand)],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }
  )

  let tarResult: ProcessResult | null = null
  let sshResult: ProcessResult | null = null
  try {
    ;[tarResult, sshResult] = await awaitWithSystemSshAbort(
      options?.signal,
      () => {
        killProcess(tarCreate)
        killProcess(sshExtract)
      },
      Promise.all([
        waitForProcess(tarCreate, 'local tar relay upload'),
        waitForProcess(sshExtract, 'system ssh relay upload'),
        pipeline(tarCreate.stdout!, sshExtract.stdin!)
      ]).then(([tar, ssh]) => [tar, ssh] as const)
    )
  } catch (err) {
    killProcess(tarCreate)
    killProcess(sshExtract)
    throw err
  }

  if (tarResult?.stderr.trim()) {
    console.warn(`[ssh-system] ${tarResult.label} stderr: ${tarResult.stderr.trim()}`)
  }
  if (sshResult?.stderr.trim()) {
    console.warn(`[ssh-system] ${sshResult.label} stderr: ${sshResult.stderr.trim()}`)
  }
}

export async function writeFileViaSystemSsh(
  target: SshTarget,
  remotePath: string,
  contents: string,
  options?: SystemSshOperationOptions
): Promise<void> {
  throwIfAborted(options?.signal)
  await writeBufferViaSystemSsh(target, remotePath, Buffer.from(contents, 'utf-8'), options)
}

async function uploadDirectoryViaSystemSshWindows(
  target: SshTarget,
  localDir: string,
  remoteDir: string,
  options: SystemSshOperationOptions
): Promise<void> {
  const hostPlatform = options.hostPlatform
  if (!hostPlatform) {
    throw new Error('Windows system SSH upload requires a remote host platform')
  }
  const plan = await collectWindowsUploadPlan(localDir, remoteDir, hostPlatform, options.signal)
  await createWindowsUploadDirectories(target, plan.directories, options)
  for (const file of plan.files) {
    throwIfAborted(options.signal)
    // Reuses the single-file upload: it already opens O_NOFOLLOW, verifies the source did not
    // change under it, and splits the bytes into stdin-sized writes staged under a partial name.
    await uploadFileViaSystemSsh(target, file.localPath, file.remotePath, options)
  }
}

type WindowsUploadPlan = {
  directories: string[]
  files: { localPath: string; remotePath: string }[]
}

/**
 * #16432: this used to base64 every artifact into one JSON array and push the whole ~1.9MB string
 * into one PowerShell stdin. Base64 inflates the payload 1.33x, and Windows PowerShell 5.1 cannot
 * read a stdin that large over a non-pty ssh exec — it blocks forever instead of failing. Nothing
 * about a directory upload requires one frame: the plan carries paths only, and the bytes go per
 * file, in writes bounded by WINDOWS_STDIN_WRITE_CHUNK_BYTES.
 */
async function collectWindowsUploadPlan(
  localDir: string,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  signal: AbortSignal | undefined,
  plan: WindowsUploadPlan = { directories: [], files: [] }
): Promise<WindowsUploadPlan> {
  plan.directories.push(remoteDir)
  const dirEntries = await readdir(localDir, { withFileTypes: true })
  for (const entry of dirEntries) {
    throwIfAborted(signal)
    const localPath = pathJoin(localDir, entry.name)
    const remotePath = joinRemotePath(hostPlatform, remoteDir, entry.name)
    const statResult = await lstat(localPath)
    if (statResult.isSymbolicLink() || (!statResult.isFile() && !statResult.isDirectory())) {
      continue
    }
    if (statResult.isDirectory()) {
      await collectWindowsUploadPlan(localPath, remotePath, hostPlatform, signal, plan)
      continue
    }
    plan.files.push({ localPath, remotePath })
  }
  return plan
}

// Why the JSON envelope survives here: a path list is metadata, so this payload stays in the
// hundreds of bytes even for a deep tree. Batched anyway, so a pathological tree cannot walk back
// into the same stdin size that wedges PowerShell.
async function createWindowsUploadDirectories(
  target: SshTarget,
  directories: readonly string[],
  options: SystemSshOperationOptions
): Promise<void> {
  let batch: string[] = []
  let batchBytes = 0
  const flush = async (): Promise<void> => {
    if (batch.length === 0) {
      return
    }
    const payload = JSON.stringify(batch)
    batch = []
    batchBytes = 0
    throwIfAborted(options.signal)
    const channel = spawnSystemSshCommand(target, makeWindowsCreateDirectoriesCommand(), {
      wrapCommand: false,
      ...getSystemSshBuildArgsFromOperationOptions(options)
    })
    const closePromise = awaitWithSystemSshAbort(
      options.signal,
      () => channel.close(),
      waitForChannelClose(channel, 'windows relay upload mkdir', WINDOWS_STDIN_WRITE_TIMEOUT_MS)
    )
    if (!options.signal?.aborted) {
      channel.stdin.end(payload)
    }
    await closePromise
  }
  for (const directory of directories) {
    const entryBytes = Buffer.byteLength(directory) + 4
    if (batch.length > 0 && batchBytes + entryBytes > WINDOWS_STDIN_WRITE_CHUNK_BYTES) {
      await flush()
    }
    batch.push(directory)
    batchBytes += entryBytes
  }
  await flush()
}

function makeWindowsCreateDirectoriesCommand(): string {
  return powerShellCommand(
    [
      '$ErrorActionPreference = "Stop"',
      // The reporter measured this reader surviving 50KB where `[Console]::In` wedged at the same
      // size (#16432); the batch above stays under that.
      '$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())',
      'try { $json = $reader.ReadToEnd() } finally { $reader.Dispose() }',
      'if ([string]::IsNullOrWhiteSpace($json)) { return }',
      'foreach ($path in @($json | ConvertFrom-Json)) {',
      '  $null = [System.IO.Directory]::CreateDirectory([string]$path)',
      '}'
    ].join('; ')
  )
}
