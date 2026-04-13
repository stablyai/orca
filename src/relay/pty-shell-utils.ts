import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'

/**
 * Resolve the default shell for PTY spawning.
 * Prefers $SHELL, then common fallbacks.
 */
export function resolveDefaultShell(): string {
  const envShell = process.env.SHELL
  if (envShell && existsSync(envShell)) {
    return envShell
  }

  for (const candidate of ['/bin/bash', '/bin/zsh', '/bin/sh']) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return '/bin/sh'
}

/**
 * Resolve the current working directory of a process by pid.
 * Tries /proc on Linux and lsof on macOS before falling back to `fallbackCwd`.
 */
export async function resolveProcessCwd(pid: number, fallbackCwd: string): Promise<string> {
  // Try to read /proc/{pid}/cwd on Linux
  const procCwd = `/proc/${pid}/cwd`
  if (existsSync(procCwd)) {
    try {
      const { readlinkSync } = await import('fs')
      return readlinkSync(procCwd)
    } catch {
      // Fall through
    }
  }

  // Fallback: use lsof on macOS
  try {
    const output = execFileSync('lsof', ['-p', String(pid), '-Fn'], {
      encoding: 'utf-8',
      timeout: 3000
    })
    const lines = output.split('\n')
    for (const line of lines) {
      if (line.startsWith('n') && line.includes('/')) {
        const candidate = line.slice(1)
        if (existsSync(candidate)) {
          return candidate
        }
      }
    }
  } catch {
    // Fall through
  }

  return fallbackCwd
}

/**
 * Check whether a process has child processes (via pgrep).
 */
export function processHasChildren(pid: number): boolean {
  try {
    const output = execFileSync('pgrep', ['-P', String(pid)], {
      encoding: 'utf-8',
      timeout: 3000
    })
    return output.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Get the foreground process name of a given pid (via ps).
 */
export function getForegroundProcessName(pid: number): string | null {
  try {
    const output = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 3000
    })
    return output.trim() || null
  } catch {
    return null
  }
}

/**
 * List available shell profiles from /etc/shells (or known fallbacks).
 */
export function listShellProfiles(): { name: string; path: string }[] {
  const profiles: { name: string; path: string }[] = []
  const seen = new Set<string>()

  try {
    const content = readFileSync('/etc/shells', 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) {
        continue
      }
      if (!existsSync(trimmed)) {
        continue
      }
      if (seen.has(trimmed)) {
        continue
      }
      seen.add(trimmed)

      const name = trimmed.split('/').pop() || trimmed
      profiles.push({ name, path: trimmed })
    }
  } catch {
    // /etc/shells may not exist on all systems; fall back to known shells
    for (const candidate of ['/bin/bash', '/bin/zsh', '/bin/sh']) {
      if (existsSync(candidate) && !seen.has(candidate)) {
        seen.add(candidate)
        const name = candidate.split('/').pop()!
        profiles.push({ name, path: candidate })
      }
    }
  }

  return profiles
}
