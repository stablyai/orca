import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
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
import { writeBufferViaSystemSsh } from './system-ssh-file-binary-transfer'

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
  const entries = await collectWindowsUploadEntries(
    localDir,
    remoteDir,
    hostPlatform,
    options.signal
  )
  await writeWindowsUploadPackageViaSystemSsh(target, entries, options)
}

type WindowsUploadEntry =
  | {
      kind: 'directory'
      path: string
    }
  | {
      kind: 'file'
      path: string
      contentsBase64: string
    }

async function collectWindowsUploadEntries(
  localDir: string,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  signal: AbortSignal | undefined
): Promise<WindowsUploadEntry[]> {
  const entries: WindowsUploadEntry[] = [{ kind: 'directory', path: remoteDir }]
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
      entries.push(
        ...(await collectWindowsUploadEntries(localPath, remotePath, hostPlatform, signal))
      )
      continue
    }
    const buffer = await readLocalUploadFile(localPath, statResult)
    entries.push({ kind: 'file', path: remotePath, contentsBase64: buffer.toString('base64') })
  }
  return entries
}

async function writeWindowsUploadPackageViaSystemSsh(
  target: SshTarget,
  entries: WindowsUploadEntry[],
  options: SystemSshOperationOptions
): Promise<void> {
  throwIfAborted(options.signal)
  const channel = spawnSystemSshCommand(target, makeWindowsUploadPackageCommand(), {
    wrapCommand: false,
    ...getSystemSshBuildArgsFromOperationOptions(options)
  })
  const closePromise = awaitWithSystemSshAbort(
    options.signal,
    () => channel.close(),
    waitForChannelClose(channel, 'windows relay upload')
  )
  if (!options.signal?.aborted) {
    channel.stdin.end(JSON.stringify(entries))
  }
  await closePromise
}

async function readLocalUploadFile(
  localPath: string,
  statResult: Awaited<ReturnType<typeof lstat>>
): Promise<Buffer> {
  const handle = await open(localPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const openedStat = await handle.stat()
    if (
      !openedStat.isFile() ||
      openedStat.size !== statResult.size ||
      (statResult.ino !== 0 && openedStat.ino !== 0 && openedStat.ino !== statResult.ino) ||
      (statResult.dev !== 0 && openedStat.dev !== 0 && openedStat.dev !== statResult.dev)
    ) {
      throw new Error(`File changed during upload: ${localPath}`)
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

function makeWindowsUploadPackageCommand(): string {
  return powerShellCommand(
    [
      '$ErrorActionPreference = "Stop"',
      '$json = [Console]::In.ReadToEnd()',
      'if ([string]::IsNullOrWhiteSpace($json)) { return }',
      '$items = $json | ConvertFrom-Json',
      'foreach ($item in @($items)) {',
      '  $path = [string]$item.path',
      '  if ($item.kind -eq "directory") {',
      '    $null = [System.IO.Directory]::CreateDirectory($path)',
      '    continue',
      '  }',
      '  $parent = [System.IO.Path]::GetDirectoryName($path)',
      '  if ($parent) { $null = [System.IO.Directory]::CreateDirectory($parent) }',
      '  [System.IO.File]::WriteAllBytes($path, [Convert]::FromBase64String([string]$item.contentsBase64))',
      '}'
    ].join('; ')
  )
}
