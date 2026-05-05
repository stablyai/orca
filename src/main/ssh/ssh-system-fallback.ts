import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import type { SshTarget } from '../../shared/ssh-types'

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

/**
 * Find the system ssh binary path. Returns null if not found.
 */
export function findSystemSsh(): string | null {
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

function buildSshArgs(target: SshTarget): string[] {
  const args: string[] = []

  args.push('-o', 'BatchMode=no')
  // Forward stdin/stdout for relay communication
  args.push('-T')

  if (target.port !== 22) {
    args.push('-p', String(target.port))
  }

  if (target.identityFile) {
    args.push('-i', target.identityFile)
  }

  if (target.jumpHost) {
    args.push('-J', target.jumpHost)
  }

  if (target.proxyCommand) {
    args.push('-o', `ProxyCommand=${target.proxyCommand}`)
  }

  const userHost = target.username ? `${target.username}@${target.host}` : target.host
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
