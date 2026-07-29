import { existsSync } from 'node:fs'

const SYSTEM_SSH_PATHS =
  process.platform === 'win32'
    ? ['C:\\Windows\\System32\\OpenSSH\\ssh.exe', 'ssh.exe']
    : ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh']

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
