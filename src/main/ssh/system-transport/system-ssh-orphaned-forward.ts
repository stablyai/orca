/**
 * An `ssh -N -L` forward a previous Orca left behind — after a crash, a force-quit, or a version
 * that did not stop its forwards on quit — keeps holding the fixed local port a managed tunnel
 * binds, so every later start fails with EADDRINUSE. Only a process whose argv is exactly the one
 * Orca would spawn for this same forward and host, and whose parent is gone, qualifies: a user's
 * own ssh and a live Orca's tunnel never match.
 */
import { parseWindowsCommandLine } from '@orca/process-host/windows-command-line'
import { getFreshShellForegroundSnapshot } from '../../../shared/process-table-snapshot-reader'
import { readWindowsProcessTableFresh } from '../../windows/windows-process-table'
import {
  PROCESS_START_TIME_TOLERANCE_MS,
  readProcessStartTimeMs
} from '../../runtime/agent-session-process-identity-probe'

export type SshForwardProcessRow = {
  pid: number
  ppid: number
  command: string
  /** Windows creation time; `startTime` is the posix tables' opaque start marker. */
  creationTimeMs?: number
  startTime?: string
}

type OrphanedForwardDeps = {
  listProcesses: () => Promise<SshForwardProcessRow[]>
  kill: (pid: number, signal: NodeJS.Signals | 0) => void
  readStartTimeMs: (pid: number) => Promise<number | null>
  platform: NodeJS.Platform
}

const DEFAULT_DEPS: OrphanedForwardDeps = {
  listProcesses: () =>
    process.platform === 'win32'
      ? readWindowsProcessTableFresh()
      : getFreshShellForegroundSnapshot(),
  kill: (pid, signal) => {
    process.kill(pid, signal)
  },
  readStartTimeMs: (pid) => readProcessStartTimeMs(pid),
  platform: process.platform
}

const EXIT_POLL_MS = 50
const TERM_WAIT_MS = 2_000
const KILL_WAIT_MS = 500

// Init and the per-user subreapers an orphan is handed to.
const REAPER_NAMES = new Set(['init', 'launchd', 'systemd'])

function programName(executable: string): string {
  return (executable.replaceAll('"', '').split(/[\\/]/).pop() ?? '').toLowerCase()
}

function splitExecutable(command: string): { name: string; rest: string } {
  const end = command.startsWith('"') ? command.indexOf('"', 1) + 1 : command.search(/\s|$/)
  return { name: programName(command.slice(0, end)), rest: command.slice(end).trim() }
}

function executableName(command: string): string {
  return splitExecutable(command).name
}

// Why: versions before STA-10471 spawned the same argv with ExitOnForwardFailure=yes, and
// versions before #24863's fix without LogLevel=INFO.
function normalizeForwardArgv(args: readonly string[]): string[] {
  const normalized: string[] = []
  let droppedLogLevel = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (!droppedLogLevel && arg === '-o' && args[index + 1] === 'LogLevel=INFO') {
      droppedLogLevel = true
      index += 1
      continue
    }
    normalized.push(arg.replace(/^ExitOnForwardFailure=(?:yes|no)$/, 'ExitOnForwardFailure=*'))
  }
  return normalized
}

/** The command's argv after the executable; null when it is not an ssh. */
function sshArgv(command: string, platform: NodeJS.Platform): string[] | null {
  if (platform === 'win32') {
    // Why parse: Windows reports the quoted line, e.g. `-i "C:\Users\Jane Doe\.ssh\id_ed25519"`.
    const [executable = '', ...args] = parseWindowsCommandLine(command)
    const name = programName(executable)
    return name === 'ssh' || name === 'ssh.exe' ? args : null
  }
  const { name, rest } = splitExecutable(command)
  return name === 'ssh' || name === 'ssh.exe' ? rest.split(' ') : null
}

/** The whole argv after the executable must be Orca's; any extra option is someone else's ssh. */
function isOrcaForward(
  command: string,
  expectedArgs: readonly string[],
  platform: NodeJS.Platform
): boolean {
  const argv = sshArgv(command, platform)
  if (!argv) {
    return false
  }
  // Why split: posix tables join argv with single spaces and no quoting, so argument boundaries
  // are lost; both sides are tokenized alike so a spaced value normalizes identically.
  const expectedTokens = platform === 'win32' ? expectedArgs : expectedArgs.join(' ').split(' ')
  const actual = normalizeForwardArgv(argv)
  const expected = normalizeForwardArgv(expectedTokens)
  return actual.length === expected.length && actual.every((arg, index) => arg === expected[index])
}

function parentIsGone(
  row: SshForwardProcessRow,
  byPid: Map<number, SshForwardProcessRow>,
  platform: NodeJS.Platform
): boolean {
  const parent = byPid.get(row.ppid)
  if (platform === 'win32') {
    // Windows never reparents; a recycled pid shows up as a parent younger than its child.
    return (
      !parent ||
      (parent.creationTimeMs !== undefined &&
        row.creationTimeMs !== undefined &&
        parent.creationTimeMs > row.creationTimeMs)
    )
  }
  return row.ppid <= 1 || !parent || REAPER_NAMES.has(executableName(parent.command))
}

/** `expectedArgs` is the argv after the ssh executable that Orca spawns for this forward. */
export function findOrphanedOrcaSshForward(
  rows: readonly SshForwardProcessRow[],
  expectedArgs: readonly string[],
  platform: NodeJS.Platform
): SshForwardProcessRow | null {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  return (
    rows.find(
      (row) =>
        isOrcaForward(row.command, expectedArgs, platform) && parentIsGone(row, byPid, platform)
    ) ?? null
  )
}

function isGone(pid: number, kill: OrphanedForwardDeps['kill']): boolean {
  try {
    kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}

async function waitUntilGone(
  pid: number,
  kill: OrphanedForwardDeps['kill'],
  ms: number
): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += EXIT_POLL_MS) {
    if (isGone(pid, kill)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS))
  }
  return isGone(pid, kill)
}

/** True when an orphaned Orca forward was signalled; false means nothing was touched. */
export async function stopOrphanedOrcaSshForward(
  localPort: number,
  expectedArgs: readonly string[],
  deps: OrphanedForwardDeps = DEFAULT_DEPS
): Promise<boolean> {
  const find = async (): Promise<SshForwardProcessRow | null> => {
    try {
      return findOrphanedOrcaSshForward(await deps.listProcesses(), expectedArgs, deps.platform)
    } catch {
      return null
    }
  }
  const orphan = await find()
  if (!orphan) {
    return false
  }
  console.warn(
    `[ssh] Stopping a forward a previous Orca left on 127.0.0.1:${localPort} (pid ${orphan.pid})`
  )
  const startedAtMs = await deps.readStartTimeMs(orphan.pid)
  try {
    deps.kill(orphan.pid, 'SIGTERM')
    if (await waitUntilGone(orphan.pid, deps.kill, TERM_WAIT_MS)) {
      return true
    }
    // Why: the pid may have exited and been reused while we polled; SIGKILL only on proof that it
    // is still the same process, never when its start time cannot be read.
    const still = await find()
    const stillStartedAtMs = await deps.readStartTimeMs(orphan.pid)
    if (
      still?.pid === orphan.pid &&
      startedAtMs !== null &&
      stillStartedAtMs !== null &&
      Math.abs(stillStartedAtMs - startedAtMs) <= PROCESS_START_TIME_TOLERANCE_MS
    ) {
      deps.kill(orphan.pid, 'SIGKILL')
      await waitUntilGone(orphan.pid, deps.kill, KILL_WAIT_MS)
    }
  } catch {
    // Exited between the table read and the signal; the caller's retry decides.
  }
  return true
}
