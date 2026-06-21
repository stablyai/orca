import { execFile as execFileCb } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { win32 as pathWin32 } from 'path'
import { promisify } from 'util'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess,
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from '../shared/agent-process-recognition'
import { getFirstCommandToken } from '../shared/command-token-scanner'
import { isShellProcess } from '../shared/shell-process-detection'
import {
  resolveWindowsAgentForegroundProcess,
  shouldInspectWindowsAgentForeground
} from '../main/providers/windows-agent-foreground-process'

const execFile = promisify(execFileCb)

type ProcessRow = {
  pid: number
  ppid: number
  stat: string
  command: string
}

export function resolveWindowsDefaultShell(
  env: NodeJS.ProcessEnv = process.env,
  existsPath: (path: string) => boolean = existsSync
): string {
  const envShell = env.SHELL
  if (envShell && existsPath(envShell)) {
    return envShell
  }

  const systemRoot = env.SystemRoot || env.WINDIR || env.windir || 'C:\\Windows'
  const windowsPowerShell = pathWin32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  if (existsPath(windowsPowerShell)) {
    return windowsPowerShell
  }

  const comspec = env.ComSpec || env.COMSPEC
  if (comspec && existsPath(comspec)) {
    return comspec
  }

  return comspec || 'powershell.exe'
}

/**
 * Resolve the default shell for PTY spawning.
 * Prefers $SHELL, then common fallbacks.
 */
export function resolveDefaultShell(): string {
  if (process.platform === 'win32') {
    return resolveWindowsDefaultShell()
  }

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

export function resolveDefaultCwd(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir = homedir()
): string {
  if (platform === 'win32') {
    const driveHome = env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined
    return env.USERPROFILE || env.HOME || driveHome || homeDir || `${env.SystemDrive || 'C:'}\\`
  }

  return env.HOME || homeDir || '/'
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
    // Why: `-a` ANDs the -p and -d filters. Without it, macOS lsof ORs them
    // and emits cwd records for every process on the system, so the n-line
    // scan below picks up the first unrelated process (often pid ~391 with
    // cwd `/`) and returns `/` regardless of the target pid's real cwd.
    const { stdout: output } = await execFile(
      'lsof',
      ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      {
        encoding: 'utf-8',
        timeout: 3000
      }
    )
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

function parsePsRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    if (!match) {
      continue
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      stat: match[3],
      command: match[4]
    })
  }
  return rows
}

function collectDescendants(
  rows: ProcessRow[],
  rootPid: number
): (ProcessRow & { depth: number })[] {
  const childrenByParent = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row)
    childrenByParent.set(row.ppid, children)
  }

  const descendants: (ProcessRow & { depth: number })[] = []
  const stack = (childrenByParent.get(rootPid) ?? []).map((row) => ({ row, depth: 1 }))
  while (stack.length > 0) {
    const { row, depth } = stack.pop()!
    descendants.push({ ...row, depth })
    for (const child of childrenByParent.get(row.pid) ?? []) {
      stack.push({ row: child, depth: depth + 1 })
    }
  }
  return descendants
}

function candidateScore(row: ProcessRow & { depth: number }): number {
  return (row.stat.includes('+') ? 10_000 : 0) + row.depth
}

function processCommandToken(command: string): string {
  return getFirstCommandToken(command)
}

function candidateMatchesFallbackWrapper(candidate: ProcessRow, fallbackProcess: string): boolean {
  return isExpectedAgentProcess(processCommandToken(candidate.command), fallbackProcess)
}

async function getRecognizedForegroundDescendant(
  pid: number,
  fallbackProcess?: string | null
): Promise<string | null> {
  try {
    const { stdout } = await execFile('ps', ['-axo', 'pid=,ppid=,stat=,command='], {
      encoding: 'utf-8',
      timeout: 3000
    })
    const rows = parsePsRows(stdout)
    const root = rows.find((row) => row.pid === pid)
    const candidates = collectDescendants(rows, pid).sort(
      (a, b) => candidateScore(b) - candidateScore(a)
    )
    // Why: SSH relays do not have the daemon's async wrapper cache. Inspect the
    // remote process tree so node/python agent entrypoints become real agents.
    const foregroundIsKnown =
      root?.stat.includes('+') === true ||
      candidates.some((candidate) => candidate.stat.includes('+'))
    const foregroundCandidates = foregroundIsKnown
      ? candidates.filter((candidate) => candidate.stat.includes('+'))
      : candidates
    const inspectionCandidates =
      fallbackProcess && isAgentForegroundWrapperProcess(fallbackProcess)
        ? foregroundCandidates.filter((candidate) =>
            candidateMatchesFallbackWrapper(candidate, fallbackProcess)
          )
        : foregroundCandidates
    if (
      fallbackProcess &&
      isAgentForegroundWrapperProcess(fallbackProcess) &&
      inspectionCandidates.length !== 1
    ) {
      return null
    }
    for (const candidate of inspectionCandidates) {
      const recognized = recognizeAgentProcessFromCommandLine(candidate.command)
      if (recognized) {
        return recognized.processName
      }
    }
  } catch {
    // Fall through to node-pty's process name or the root command name.
  }
  return null
}

/**
 * Get the foreground process name of a given pid (via ps).
 */
export async function getForegroundProcessName(
  pid: number,
  fallbackProcess?: string | null
): Promise<string | null> {
  if (fallbackProcess) {
    const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
    if (fallbackRecognition) {
      return fallbackRecognition.processName
    }
    if (process.platform === 'win32') {
      if (!shouldInspectWindowsAgentForeground(fallbackProcess)) {
        return fallbackProcess
      }
      return (
        (await resolveWindowsAgentForegroundProcess(pid, fallbackProcess, {})) ?? fallbackProcess
      )
    }
    if (!isShellProcess(fallbackProcess) && !isAgentForegroundWrapperProcess(fallbackProcess)) {
      return fallbackProcess
    }
  }
  const recognized = await getRecognizedForegroundDescendant(pid, fallbackProcess)
  if (recognized) {
    return recognized
  }
  if (fallbackProcess) {
    return fallbackProcess
  }
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
