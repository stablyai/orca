/* eslint-disable max-lines -- Why: system-ssh process wrapping and fallback file operations share cleanup contracts. */
import { spawn, type ChildProcess } from 'child_process'
import { constants } from 'node:fs'
import { existsSync } from 'fs'
import { lstat, open, readdir } from 'fs/promises'
import { join as pathJoin } from 'path'
import { Duplex } from 'stream'
import { pipeline } from 'stream/promises'
import type { ClientChannel } from 'ssh2'
import type { SshTarget } from '../../shared/ssh-types'
import { wrapRemoteCommandForPosixShell, shellEscape } from './ssh-connection-utils'
import type { SshExecOptions } from './ssh-connection-utils'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'

const SYSTEM_SSH_PATHS =
  process.platform === 'win32'
    ? ['C:\\Windows\\System32\\OpenSSH\\ssh.exe', 'ssh.exe']
    : ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh']

export type SystemSshProcess = {
  stdin: NodeJS.WritableStream
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  kill: () => void
  onExit: (cb: (code: number | null) => void) => void
  pid: number | undefined
}

type SystemSshCommandChannel = ClientChannel & {
  _process?: ChildProcess
}

type SystemSshOperationOptions = {
  signal?: AbortSignal
  hostPlatform?: RemoteHostPlatform
}

/**
 * Find the system ssh binary path. Returns null if not found.
 */
export function findSystemSsh(): string | null {
  if (process.env.ORCA_SYSTEM_SSH_PATH) {
    return process.env.ORCA_SYSTEM_SSH_PATH
  }
  for (const candidate of SYSTEM_SSH_PATHS) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

/**
 * Spawn a system ssh process connecting to the given target.
 * Used when ssh2 cannot handle the auth method (FIDO2, ControlMaster).
 *
 * The returned process's stdin/stdout are used as the transport for
 * the relay's JSON-RPC protocol, exactly like an ssh2 channel.
 */
export function spawnSystemSsh(target: SshTarget): SystemSshProcess {
  const sshPath = findSystemSsh()
  if (!sshPath) {
    throw new Error(
      'No system ssh binary found. Install OpenSSH to use FIDO2 keys or ControlMaster.'
    )
  }

  const args = buildSshArgs(target)
  const proc = spawn(sshPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })

  return wrapChildProcess(proc)
}

export function spawnSystemSshCommand(
  target: SshTarget,
  command: string,
  options?: SshExecOptions
): ClientChannel {
  const sshPath = findSystemSsh()
  if (!sshPath) {
    throw new Error(
      'No system ssh binary found. Install OpenSSH to use ProxyUseFdpass, FIDO2 keys, or ControlMaster.'
    )
  }

  const remoteCommand =
    options?.wrapCommand === false ? command : wrapRemoteCommandForPosixShell(command)
  const proc = spawn(sshPath, [...buildSshArgs(target), remoteCommand], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  return wrapCommandProcess(proc)
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
    [...buildSshArgs(target), wrapRemoteCommandForPosixShell(remoteCommand)],
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
  if (options?.hostPlatform && isWindowsRemoteHost(options.hostPlatform)) {
    await writeBufferViaSystemSshWindows(
      target,
      remotePath,
      Buffer.from(contents, 'utf-8'),
      options
    )
    return
  }

  const channel = spawnSystemSshCommand(target, `cat > ${shellEscape(remotePath)}`)
  const closePromise = awaitWithSystemSshAbort(
    options?.signal,
    () => channel.close(),
    waitForChannelClose(channel, `write ${remotePath}`)
  )
  if (!options?.signal?.aborted) {
    channel.stdin.end(contents)
  }
  await closePromise
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
    wrapCommand: false
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

async function writeBufferViaSystemSshWindows(
  target: SshTarget,
  remotePath: string,
  contents: Buffer,
  options: SystemSshOperationOptions
): Promise<void> {
  throwIfAborted(options.signal)
  const channel = spawnSystemSshCommand(target, makeWindowsWriteFileCommand(remotePath), {
    wrapCommand: false
  })
  const closePromise = awaitWithSystemSshAbort(
    options.signal,
    () => channel.close(),
    waitForChannelClose(channel, `write ${remotePath}`)
  )
  if (!options.signal?.aborted) {
    channel.stdin.end(contents)
  }
  await closePromise
}

function makeWindowsWriteFileCommand(remotePath: string): string {
  return powerShellCommand(
    [
      '$ErrorActionPreference = "Stop"',
      `$path = ${powerShellLiteral(remotePath)}`,
      '$parent = [System.IO.Path]::GetDirectoryName($path)',
      'if ($parent) { $null = [System.IO.Directory]::CreateDirectory($parent) }',
      '$inputStream = [Console]::OpenStandardInput()',
      '$outputStream = [System.IO.File]::Open($path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)',
      'try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }'
    ].join('; ')
  )
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

export function buildSshArgs(target: SshTarget): string[] {
  const args: string[] = []

  args.push('-o', 'BatchMode=no')
  // Forward stdin/stdout for relay communication
  args.push('-T')

  // Why: configHost preserves OpenSSH-only directives such as ProxyUseFdpass.
  // Passing resolved host/port/proxy flags would bypass the user's Host block.
  const useConfigHost = Boolean(target.configHost)

  if (!useConfigHost && target.port !== 22) {
    args.push('-p', String(target.port))
  }

  if (!useConfigHost && target.identityFile) {
    args.push('-i', target.identityFile)
  }

  if (!useConfigHost && target.identityAgent) {
    args.push('-o', `IdentityAgent=${target.identityAgent}`)
  }

  if (!useConfigHost && target.identitiesOnly) {
    args.push('-o', 'IdentitiesOnly=yes')
  }

  if (!useConfigHost && target.jumpHost) {
    args.push('-J', target.jumpHost)
  }

  if (!useConfigHost && target.proxyCommand) {
    args.push('-o', `ProxyCommand=${target.proxyCommand}`)
  }

  const host = target.configHost || target.host
  const userHost = target.username ? `${target.username}@${host}` : host
  args.push('--', userHost)

  return args
}

function wrapChildProcess(proc: ChildProcess): SystemSshProcess {
  return {
    stdin: proc.stdin!,
    stdout: proc.stdout!,
    stderr: proc.stderr!,
    pid: proc.pid,
    kill: () => {
      try {
        proc.kill('SIGTERM')
      } catch {
        // Process may already be dead
      }
    },
    onExit: (cb) => {
      proc.on('exit', (code) => cb(code))
    }
  }
}

function wrapCommandProcess(proc: ChildProcess): SystemSshCommandChannel {
  const duplex = new Duplex({
    read() {},
    write(chunk, encoding, cb) {
      proc.stdin!.write(chunk, encoding, cb)
    }
  })
  const channel = duplex as unknown as SystemSshCommandChannel

  const mutableChannel = channel as unknown as {
    stdin: NodeJS.WritableStream
    stderr: NodeJS.ReadableStream
    _process?: ChildProcess
    close: () => void
  }
  mutableChannel.stdin = proc.stdin!
  mutableChannel.stderr = proc.stderr!
  mutableChannel._process = proc
  mutableChannel.close = () => {
    try {
      proc.kill('SIGTERM')
    } catch {
      // Process may already be dead
    }
  }

  const cleanupProcessListeners = (): void => {
    proc.stdout!.off('data', onStdoutData)
    proc.stdout!.off('end', onStdoutEnd)
    proc.off('exit', onExit)
    proc.off('close', onClose)
    proc.off('error', onProcessError)
    proc.stdin!.off('error', onStreamError)
    proc.stdout!.off('error', onStreamError)
  }
  const fail = (err: Error): void => {
    cleanupProcessListeners()
    duplex.destroy(err)
  }
  const onStdoutData = (data: Buffer): void => {
    duplex.push(data)
  }
  const onStdoutEnd = (): void => {
    duplex.push(null)
  }
  const onExit = (code: number | null, signal?: NodeJS.Signals | null): void => {
    channel.emit('exit', code, signal)
  }
  const onClose = (code: number | null, signal?: NodeJS.Signals | null): void => {
    cleanupProcessListeners()
    channel.emit('close', code, signal)
  }
  const onProcessError = (err: Error): void => {
    fail(err)
  }
  const onStreamError = (err: Error): void => {
    fail(err)
  }

  proc.stdout!.on('data', onStdoutData)
  proc.stdout!.on('end', onStdoutEnd)
  proc.on('exit', onExit)
  proc.on('close', onClose)
  proc.on('error', onProcessError)
  proc.stdin!.on('error', onStreamError)
  proc.stdout!.on('error', onStreamError)

  return channel
}

function waitForChannelClose(channel: SystemSshCommandChannel, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    const cleanup = (): void => {
      channel.stderr.off('data', onStderrData)
      channel.off('error', onError)
      channel.off('close', onClose)
    }
    const settle = (fn: typeof resolve | typeof reject, val?: unknown): void => {
      cleanup()
      fn(val as never)
    }
    const onStderrData = (data: Buffer): void => {
      stderr += data.toString('utf-8')
    }
    const onError = (err: Error): void => {
      settle(reject, err)
    }
    const onClose = (code: number | null, signal?: NodeJS.Signals | null): void => {
      if (code !== 0) {
        const detail = code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`
        settle(reject, new Error(`${label} failed (${detail}): ${stderr.trim()}`))
        return
      }
      settle(resolve)
    }

    channel.stderr.on('data', onStderrData)
    channel.on('error', onError)
    channel.on('close', onClose)
  })
}

type ProcessResult = { label: string; stderr: string }

function waitForProcess(proc: ChildProcess, label: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    const cleanup = (): void => {
      proc.stderr?.off('data', onStderrData)
      proc.off('error', onError)
      proc.off('close', onClose)
    }
    const settle = (fn: typeof resolve | typeof reject, val: ProcessResult | Error): void => {
      cleanup()
      fn(val as never)
    }
    const onStderrData = (data: Buffer): void => {
      stderr += data.toString('utf-8')
    }
    const onError = (err: Error): void => {
      settle(reject, err)
    }
    const onClose = (code: number | null): void => {
      if (code !== 0) {
        settle(reject, new Error(`${label} failed (exit ${code}): ${stderr.trim()}`))
        return
      }
      settle(resolve, { label, stderr })
    }

    proc.stderr?.on('data', onStderrData)
    proc.on('error', onError)
    proc.on('close', onClose)
  })
}

function killProcess(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.killed) {
    return
  }
  try {
    proc.kill('SIGTERM')
  } catch {
    // Process may already be dead
  }
}

async function awaitWithSystemSshAbort<T>(
  signal: AbortSignal | undefined,
  abortChildren: () => void,
  operation: Promise<T>
): Promise<T> {
  if (!signal) {
    return operation
  }
  let abortReject: ((error: Error) => void) | null = null
  let suppressLateOperationError = false
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortReject = reject
  })
  const abort = (): void => {
    // Why: abort is connection teardown; do not wait for stubborn system ssh/tar
    // children to emit close after we've already signaled them.
    abortChildren()
    suppressLateOperationError = true
    abortReject?.(createAbortError())
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) {
    abort()
  }
  try {
    return await Promise.race([
      operation.catch((error: unknown) => {
        if (suppressLateOperationError) {
          return new Promise<never>(() => {})
        }
        throw error
      }),
      abortPromise
    ])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return
  }
  throw createAbortError()
}

function createAbortError(): Error & { name: string } {
  const error = new Error('System SSH operation was cancelled') as Error & { name: string }
  error.name = 'AbortError'
  return error
}
