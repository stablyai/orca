import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { Duplex } from 'stream'
import { pipeline } from 'stream/promises'
import type { ClientChannel } from 'ssh2'
import type { SshTarget } from '../../shared/ssh-types'
import { wrapRemoteCommandForPosixShell, shellEscape } from './ssh-connection-utils'

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

export function spawnSystemSshCommand(target: SshTarget, command: string): ClientChannel {
  const sshPath = findSystemSsh()
  if (!sshPath) {
    throw new Error(
      'No system ssh binary found. Install OpenSSH to use ProxyUseFdpass, FIDO2 keys, or ControlMaster.'
    )
  }

  const proc = spawn(sshPath, [...buildSshArgs(target), wrapRemoteCommandForPosixShell(command)], {
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

  const abort = (): void => {
    killProcess(tarCreate)
    killProcess(sshExtract)
  }
  options?.signal?.addEventListener('abort', abort, { once: true })
  let tarResult: ProcessResult | null = null
  let sshResult: ProcessResult | null = null
  try {
    ;[tarResult, sshResult] = await Promise.all([
      waitForProcess(tarCreate, 'local tar relay upload'),
      waitForProcess(sshExtract, 'system ssh relay upload'),
      pipeline(tarCreate.stdout!, sshExtract.stdin!)
    ]).then(([tar, ssh]) => [tar, ssh])
  } catch (err) {
    killProcess(tarCreate)
    killProcess(sshExtract)
    throw err
  } finally {
    options?.signal?.removeEventListener('abort', abort)
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
  const channel = spawnSystemSshCommand(target, `cat > ${shellEscape(remotePath)}`)
  const abort = (): void => {
    channel.close()
  }
  options?.signal?.addEventListener('abort', abort, { once: true })
  const closePromise = waitForChannelClose(channel, `write ${remotePath}`)
  channel.stdin.end(contents)
  try {
    await closePromise
  } finally {
    options?.signal?.removeEventListener('abort', abort)
  }
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

  proc.stdout!.on('data', (data) => duplex.push(data))
  proc.stdout!.on('end', () => duplex.push(null))
  proc.on('exit', (code, signal) => channel.emit('exit', code, signal))
  proc.on('close', (code, signal) => channel.emit('close', code, signal))
  proc.on('error', (err) => duplex.destroy(err))
  proc.stdin!.on('error', (err) => duplex.destroy(err))
  proc.stdout!.on('error', (err) => duplex.destroy(err))

  return channel
}

function waitForChannelClose(channel: SystemSshCommandChannel, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    channel.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf-8')
    })
    channel.on('error', reject)
    channel.on('close', (code: number | null, signal?: NodeJS.Signals | null) => {
      if (code !== 0) {
        const detail = code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`
        reject(new Error(`${label} failed (${detail}): ${stderr.trim()}`))
        return
      }
      resolve()
    })
  })
}

type ProcessResult = { label: string; stderr: string }

function waitForProcess(proc: ChildProcess, label: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString('utf-8')
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${label} failed (exit ${code}): ${stderr.trim()}`))
        return
      }
      resolve({ label, stderr })
    })
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return
  }
  const error = new Error('System SSH operation was cancelled') as Error & { name: string }
  error.name = 'AbortError'
  throw error
}
