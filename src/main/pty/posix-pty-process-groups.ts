import { hasControllingTty } from '../../shared/posix-controlling-terminal'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'
import {
  parseProcessRows,
  readLinuxProcessSessionId,
  readLinuxProcessSessionIdAsync,
  readPosixPtyProcessTable,
  readPosixPtyProcessTableSync
} from './posix-pty-process-table'

type PosixPtyGroupSignalDeps = {
  platform?: NodeJS.Platform
  currentPid?: number
  signalProcessGroup?: (pgid: number) => void
}

export type PosixPtyProcessGroupTerminationDeps = PosixPtyGroupSignalDeps & {
  readProcessTable?: () => string
  /** Linux session id of a pid, or null when unreadable. */
  readProcessSessionId?: (pid: number) => number | null
}

export type PosixPtyProcessGroupSignalDeps = PosixPtyGroupSignalDeps & {
  readProcessTable?: () => Promise<string>
  /** Linux session id of a pid, or null when unreadable. */
  readProcessSessionId?: (pid: number) => Promise<number | null>
  /** False once the root has exited; its pid and TTY may then belong to another terminal. */
  ownsRoot?: () => boolean
}

export function isPosixPtyRootStopped(output: string, rootPid: number): boolean {
  return (
    parseProcessRows(output)
      .find((row) => row.pid === rootPid)
      ?.state?.startsWith('T') === true
  )
}

export function getPosixPtyProcessGroups(
  output: string,
  rootPid: number,
  currentPid = process.pid,
  readSessionId?: (pid: number) => number | null
): number[] | null {
  const rows = parseProcessRows(output)
  const root = rows.find((row) => row.pid === rootPid)
  if (!root || !hasControllingTty(root.tty)) {
    return null
  }
  // A dev daemon may share the PTY; never group-signal Orca itself.
  if (rows.some((row) => row.pid === currentPid && row.tty === root.tty)) {
    return null
  }
  let members = rows.filter((row) => row.tty === root.tty)
  if (readSessionId) {
    // Container devpts numbers overlap: prove the root leads this session; setsid descendants no longer own its TTY (#16714).
    if (readSessionId(rootPid) !== rootPid) {
      return null
    }
    members = members.filter((row) => readSessionId(row.pid) === rootPid)
  }
  const groups = new Set(members.map((row) => row.pgid))
  if (!groups.has(root.pgid)) {
    return null
  }
  return [...groups].sort((left, right) => {
    if (left === root.pgid) {
      return 1
    }
    if (right === root.pgid) {
      return -1
    }
    return left - right
  })
}

function isProcessAlreadyGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH'
}

/** Force-kill every process group still attached to one POSIX PTY without blocking the event loop. */
export function forceKillPosixPtyProcessGroups(
  rootPid: number,
  fallback: () => void,
  deps: PosixPtyProcessGroupSignalDeps = {}
): Promise<void> {
  return signalPosixPtyProcessGroups(rootPid, 'SIGKILL', fallback, deps)
}

/** Blocking variant for synchronous in-process teardown such as app quit. */
export function forceKillPosixPtyProcessGroupsSync(
  rootPid: number,
  fallback: () => void,
  deps: PosixPtyProcessGroupTerminationDeps = {}
): void {
  signalPosixPtyProcessGroupsSync(rootPid, 'SIGKILL', fallback, deps)
}

/** Signal every process group proven to belong to one POSIX PTY. */
export async function signalPosixPtyProcessGroups(
  rootPid: number,
  signal: NodeJS.Signals,
  fallback: () => void,
  deps: PosixPtyProcessGroupSignalDeps = {}
): Promise<void> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') {
    fallback()
    return
  }
  let groups: number[] | null
  try {
    const table = await (deps.readProcessTable ?? (() => readPosixPtyProcessTable(rootPid)))()
    const readSessionId =
      deps.readProcessSessionId ??
      (platform === 'linux' ? readLinuxProcessSessionIdAsync : undefined)
    groups = getPosixPtyProcessGroups(
      table,
      rootPid,
      deps.currentPid ?? process.pid,
      readSessionId ? await readSessionIds(table, rootPid, readSessionId) : undefined
    )
  } catch {
    groups = null
  }
  if (deps.ownsRoot && !deps.ownsRoot()) {
    return
  }
  deliverPosixPtyGroupSignal(groups, signal, fallback, deps)
}

function signalPosixPtyProcessGroupsSync(
  rootPid: number,
  signal: NodeJS.Signals,
  fallback: () => void,
  deps: PosixPtyProcessGroupTerminationDeps = {}
): void {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') {
    fallback()
    return
  }
  let groups: number[] | null
  try {
    groups = getPosixPtyProcessGroups(
      (deps.readProcessTable ?? (() => readPosixPtyProcessTableSync(rootPid)))(),
      rootPid,
      deps.currentPid ?? process.pid,
      deps.readProcessSessionId ?? (platform === 'linux' ? readLinuxProcessSessionId : undefined)
    )
  } catch {
    groups = null
  }
  deliverPosixPtyGroupSignal(groups, signal, fallback, deps)
}

/** Prefetch session ids for the root's terminal so group selection stays synchronous. */
async function readSessionIds(
  table: string,
  rootPid: number,
  readSessionId: (pid: number) => Promise<number | null>
): Promise<(pid: number) => number | null> {
  const rows = parseProcessRows(table)
  const rootTty = rows.find((row) => row.pid === rootPid)?.tty
  // The root's own row carries rootTty, so an absent root reads nothing.
  const pids = rows.filter((row) => rootTty !== undefined && row.tty === rootTty)
  const sessions = new Map(
    await Promise.all(pids.map(async ({ pid }) => [pid, await readSessionId(pid)] as const))
  )
  return (pid) => sessions.get(pid) ?? null
}

function deliverPosixPtyGroupSignal(
  groups: number[] | null,
  signal: NodeJS.Signals,
  fallback: () => void,
  deps: PosixPtyGroupSignalDeps
): void {
  if (!groups || groups.length === 0) {
    fallback()
    return
  }
  if (signal === 'SIGSTOP') {
    // Stop the shell before its jobs so it cannot treat their suspension as completion.
    groups.unshift(...groups.splice(-1))
  }

  const signalProcessGroup =
    deps.signalProcessGroup ?? ((pgid: number) => process.kill(-pgid, signal))
  let firstError: unknown
  for (const pgid of groups) {
    try {
      signalProcessGroup(pgid)
    } catch (error) {
      if (signal === 'SIGSTOP' && pgid === groups[0]) {
        if (isProcessAlreadyGone(error)) {
          return
        }
        throw error
      }
      // Exit callbacks may reap captured groups before killpg; ESRCH already proves them gone.
      if (!isProcessAlreadyGone(error) && firstError === undefined) {
        firstError = error
      }
      continue
    }
    // Keep breadcrumbs outside the kill catch so diagnostic errors cannot be classified as signal failures.
    if (signal === 'SIGKILL') {
      recordSelfInitiatedTreeKill({
        pid: pgid,
        site: 'posix-pty-process-group-sweep',
        scope: 'posix-process-group'
      })
    }
  }
  if (firstError !== undefined) {
    throw firstError
  }
}
