import { execFile as execFileCb } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { promisify } from 'util'

const execFile = promisify(execFileCb)

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
  // Try to read /proc/{pid}/cwd on Linux. Skip an existsSync gate — the
  // check+read pair races a concurrent exit anyway, and the catch already
  // falls through to lsof.
  try {
    const { readlinkSync } = await import('fs')
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    // Fall through
  }

  // Fallback: use lsof on macOS
  // Why: `-d cwd` restricts output to the cwd file descriptor only. Without it,
  // lsof returns ALL open files (sockets, log files, TTYs) and the first `n`-line
  // could be any of them — not the actual working directory.
  try {
    const { stdout: output } = await execFile('lsof', ['-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf-8',
      timeout: 3000
    })
    const lines = output.split('\n')
    for (const line of lines) {
      if (line.startsWith('n') && line.includes('/')) {
        // Why: lsof -d cwd is authoritative — don't second-guess it with
        // existsSync. A concurrent rmdir would race the check and cause us
        // to drop the correct answer; node-pty handles a missing cwd on
        // spawn anyway.
        return line.slice(1)
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
export async function processHasChildren(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execFile('pgrep', ['-P', String(pid)], {
      encoding: 'utf-8',
      timeout: 3000
    })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Get the foreground process name of a given pid (via ps).
 */
export async function getForegroundProcessName(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFile('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 3000
    })
    return stdout.trim() || null
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
