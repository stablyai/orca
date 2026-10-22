import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

function systemSshPaths(platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') {
    return ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh']
  }
  const systemRoot = process.env.SystemRoot || process.env.WINDIR
  return systemRoot ? [win32.join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe')] : []
}

function findSshOnPath(platform: NodeJS.Platform): string | null {
  const pathValue = process.env.PATH
  if (!pathValue) {
    return null
  }
  const pathApi = platform === 'win32' ? win32 : posix
  const executable = platform === 'win32' ? 'ssh.exe' : 'ssh'
  for (const entry of pathValue.split(pathApi.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, '')
    if (!directory) {
      continue
    }
    const candidate = pathApi.join(directory, executable)
    try {
      if (!statSync(candidate).isFile()) {
        continue
      }
      if (platform !== 'win32') {
        accessSync(candidate, constants.X_OK)
      }
      return candidate
    } catch {
      continue
    }
  }
  return null
}

/**
 * Find the system ssh binary path. Returns null if not found.
 */
export function findSystemSsh(): string | null {
  if (process.env.ORCA_SYSTEM_SSH_PATH) {
    return process.env.ORCA_SYSTEM_SSH_PATH
  }
  for (const candidate of systemSshPaths(process.platform)) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return findSshOnPath(process.platform)
}
