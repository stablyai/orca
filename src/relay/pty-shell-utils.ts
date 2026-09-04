import { execFile as execFileCb, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { win32 as pathWin32 } from 'node:path'
import { promisify } from 'node:util'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess,
  recognizeAgentProcess
} from '../shared/agent-process-recognition'
import { getFirstCommandToken } from '../shared/command-token-scanner'
import { getProcessTableIndex, type ProcessTableIndex } from '../shared/process-table-index'
import { PS_MAX_BUFFER_BYTES, type ProcessTableRow } from '../shared/process-table-snapshot'
import {
  getFreshProcessTableSnapshot,
  getProcessTableSnapshot
} from '../shared/process-table-snapshot-reader'
import { selectForegroundProcessCandidate } from '../shared/foreground-process-selection'
import {
  resolveOuterWrapperForegroundProcess,
  shouldInspectOuterWrapperForegroundProcess
} from '../shared/foreground-wrapper-agent'
import {
  resolveWindowsAgentForegroundProcess,
  shouldInspectWindowsAgentForeground
} from '../main/providers/windows-agent-foreground-process'

const execFile = promisify(execFileCb)

const OPENSSH_REGISTRY_KEY = 'HKLM\\SOFTWARE\\OpenSSH'
let openSshDefaultShell: string | undefined

export function readOpenSshDefaultShell(): string {
  if (openSshDefaultShell !== undefined) {
    return openSshDefaultShell
  }

  try {
    const output = execFileSync('reg.exe', ['query', OPENSSH_REGISTRY_KEY, '/v', 'DefaultShell'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true
    })
    const match = output.match(/^\s*DefaultShell\s+REG_\w+\s+(.+?)\s*$/im)
    openSshDefaultShell = match?.[1] ?? ''
  } catch {
    openSshDefaultShell = ''
  }

  return openSshDefaultShell
}

export function resolveWindowsDefaultShell(
  env: NodeJS.ProcessEnv = process.env,
  existsPath: (path: string) => boolean = existsSync,
  readDefaultShell: () => string = readOpenSshDefaultShell
): string {
  const envShell = env.SHELL
  if (envShell && existsPath(envShell)) {
    return envShell
  }

  const configuredShell = readDefaultShell()
  if (configuredShell && existsPath(configuredShell)) {
    return configuredShell
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
    const { readlinkSync } = await import('node:fs')
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
 * Check whether a process has child processes.
 *
 * Why the shared snapshot and not `pgrep -P`: this answers one field of
 * `pty.inspectProcess`, which every tracked pane polls on a 750ms/2000ms
 * cadence, and the fork was neither cached nor coalesced. procps-ng opens six
 * procfs files per process to resolve a ppid — including a `/proc/<pid>/ctty`
 * that never exists on Linux — so one call cost O(host process count) syscalls,
 * ~4k opens per pgrep on a 690-process host, at up to 8 forks/sec (#13537).
 * `getForegroundProcessName` in the same RPC already captured the TTL-cached
 * `ps` table, whose index carries the parent/child map, so the answer is free.
 *
 * `fresh` opts out of that TTL. A poll can read a 500ms-old table because its
 * next tick corrects it, but a close or cleanup decision acts on the answer
 * once and destructively — a child that started inside the TTL would be killed
 * with no confirmation. `pgrep` scanned per call, so anything that decides
 * has to keep scanning per call.
 */
export async function processHasChildren(
  pid: number,
  options?: { fresh?: boolean }
): Promise<boolean> {
  // Windows has no `ps`; the previous `pgrep` fork always failed here too, so
  // this keeps the same answer without spawning anything to reach it.
  if (process.platform === 'win32') {
    return false
  }
  try {
    const rows = options?.fresh
      ? await getFreshProcessTableSnapshot()
      : await getProcessTableSnapshot()
    return (getProcessTableIndex(rows).childrenByPpid.get(pid)?.length ?? 0) > 0
  } catch {
    return false
  }
}

// Why: signal 0 probes existence without delivering a signal. Only ESRCH ("no
// such process") proves the pid is gone; EPERM means it exists but is
// unsignalable, so treat every non-ESRCH outcome as alive. Kept conservative so
// a liveness check can only ever declare a *provably* dead process dead.
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function collectDescendants(
  index: ProcessTableIndex,
  rootPid: number
): (ProcessTableRow & { depth: number })[] {
  const descendants: (ProcessTableRow & { depth: number })[] = []
  const stack = (index.childrenByPpid.get(rootPid) ?? []).map((row) => ({ row, depth: 1 }))
  while (stack.length > 0) {
    const { row, depth } = stack.pop()!
    descendants.push({ ...row, depth })
    for (const child of index.childrenByPpid.get(row.pid) ?? []) {
      stack.push({ row: child, depth: depth + 1 })
    }
  }
  return descendants
}

async function getRecognizedForegroundDescendant(
  pid: number,
  fallbackProcess?: string | null
): Promise<string | null> {
  try {
    const rows = await getProcessTableSnapshot()
    return getForegroundProcessNameFromProcessTable(rows, pid, fallbackProcess)
  } catch {
    // Fall through to node-pty's process name or the root command name.
  }
  return null
}

// Why: returns null (never the fallback) so `getForegroundProcessName` keeps
// owning the fallback ladder — its wrapper branch answers with the RECOGNIZED
// process name, which is normalized where node-pty's raw name is not.
function getForegroundProcessNameFromProcessTable(
  rows: ProcessTableRow[],
  pid: number,
  fallbackProcess?: string | null
): string | null {
  // Why: one memoized index per capture, so N panes sharing the TTL-cached
  // snapshot no longer each rebuild the parent/child map over every row.
  const index = getProcessTableIndex(rows)
  const root = index.byPid.get(pid)
  const candidates = collectDescendants(index, pid)
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
          isExpectedAgentProcess(getFirstCommandToken(candidate.command), fallbackProcess)
        )
      : foregroundCandidates
  if (
    fallbackProcess &&
    isAgentForegroundWrapperProcess(fallbackProcess) &&
    inspectionCandidates.length !== 1
  ) {
    return null
  }
  const ancestryCandidates = root ? [{ ...root, depth: 0 }, ...candidates] : candidates
  const selected = selectForegroundProcessCandidate(inspectionCandidates, ancestryCandidates)
  if (selected) {
    // Why: return the outer wrapper (omp) rather than a deeper recognized helper
    // in the same process lineage.
    return resolveOuterWrapperForegroundProcess(selected.recognized, selected.candidate, candidates)
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
      // Why: node-pty can report OMP's wrapped Pi; enrich only that ambiguous
      // fallback so authoritative OMP reads keep the zero-subprocess fast path.
      if (shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)) {
        if (process.platform === 'win32') {
          return (
            (await resolveWindowsAgentForegroundProcess(pid, fallbackProcess, {})) ??
            fallbackRecognition.processName
          )
        }
        return (
          (await getRecognizedForegroundDescendant(pid, fallbackProcess)) ??
          fallbackRecognition.processName
        )
      }
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
  }
  // Why: an unrecognized name is not proof of a non-agent foreground -- macOS p_comm truncates
  // to the executable basename, which for the native Claude install is its version directory
  // (`2.1.258`). The TTL-cached table read resolves the real command line; a foreground that
  // is genuinely not an agent still answers with its own name below.
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
      timeout: 3000,
      maxBuffer: PS_MAX_BUFFER_BYTES
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

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
