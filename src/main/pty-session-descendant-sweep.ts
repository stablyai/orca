import {
  DESCENDANT_KILL_GRACE_MS,
  DESCENDANT_SNAPSHOT_TIMEOUT_MS,
  hasUnambiguousStartIdentity,
  hasUnambiguousStartTime,
  readProcessTable,
  readProcessTableBeforeDeadline,
  sendDescendantSignal,
  type ProcessTableReader,
  type ProcessTableRow,
  type SignalSender
} from './pty-descendant-termination'
import {
  DESCENDANT_KILL_VERIFY_MS,
  type DescendantTreeVerdict
} from './pty-descendant-exit-verification'
import {
  observePtySessionIdentity,
  prunePtySessionGroups,
  recordPtySessionGroups,
  type PtySessionProcessIdentity
} from './pty-session-identity'
import { collectSessionSweepTargets } from './pty-session-sweep-targets'
import { readTtyProcessTable, type TtyProcessTableReader } from './pty-session-tty-process-table'

const SWEEP_ROUND_INTERVAL_MS = 150

/** Whether any process is still in `pgid`, without reading a process table. */
export type ProcessGroupProbe = (pgid: number) => boolean

export type SessionDescendantSweepDeps = {
  readTable?: ProcessTableReader
  readTtyTable?: TtyProcessTableReader
  sendSignal?: SignalSender
  probeGroup?: ProcessGroupProbe
  graceMs?: number
  verifyMs?: number
  timeoutMs?: number
  /** A departing daemon must finish escalation after its last PTY exits. */
  keepAlive?: boolean
  platform?: NodeJS.Platform
  selfPid?: number
}

export function probeProcessGroup(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    // EPERM still means a member exists; it just is not ours to signal.
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/**
 * Whether any group the session owned still has a member. Signal 0 costs one
 * syscall per group, so a session that left nothing behind is settled without
 * forking `ps`. A live answer proves nothing about ownership — only that a
 * process table is worth reading to find out.
 */
export function hasLiveOwnedGroup(
  identity: PtySessionProcessIdentity,
  options: { exceptRootGroup?: boolean; probeGroup?: ProcessGroupProbe } = {}
): boolean {
  const probe = options.probeGroup ?? probeProcessGroup
  for (const pgid of identity.ownedGroups.keys()) {
    if (options.exceptRootGroup && pgid === identity.rootPid) {
      continue
    }
    if (probe(pgid)) {
      return true
    }
  }
  return false
}

function waitForDelay(ms: number, keepAlive: boolean): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (!keepAlive) {
      timer.unref?.()
    }
  })
}

type SignalledIdentity = { startedAt: string; pgid: number }

/**
 * Terminates everything a PTY session still owns, re-deriving the target set
 * from the session's identity on every round.
 *
 * Why re-derive rather than escalate one snapshot: the set changes underneath a
 * sweep. A surviving descendant forks while the first volley is in flight, and
 * on a natural exit there is no live root to walk from at all — only the
 * session's recorded terminal and process groups can still name that work.
 *
 * Only pids this round's table verified are signalled, never a whole group: a
 * group signal reaches whatever holds the id at delivery, which no table can
 * vouch for. A process forked between rounds is found by the next one. A pid is
 * only ever force-killed when this round's table still shows the identity that
 * was asked to stop, so a recycled pid is never signalled.
 */
export async function sweepSessionDescendants(
  identity: PtySessionProcessIdentity,
  deps: SessionDescendantSweepDeps = {}
): Promise<DescendantTreeVerdict> {
  if ((deps.platform ?? process.platform) === 'win32') {
    // Windows reaches the whole tree through the pty's job object.
    return 'exited'
  }
  const readTable = deps.readTable ?? readProcessTable
  const readTtyTable = deps.readTtyTable ?? readTtyProcessTable
  const sendSignal = deps.sendSignal ?? sendDescendantSignal
  const timeoutMs = deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
  const readTty = async (): Promise<readonly ProcessTableRow[] | undefined> =>
    identity.ttyName ? (await readTtyTable(identity.ttyName, timeoutMs))?.rows : undefined

  let ttyRows: readonly ProcessTableRow[] | undefined
  const exitedAtMs = identity.rootExitedAtMs
  if (exitedAtMs !== null && !hasLiveOwnedGroup(identity, { probeGroup: deps.probeGroup })) {
    // Every owned group is empty, so only the terminal can still hold this
    // session's work — and after exit, only a process born before it.
    ttyRows = await readTty()
    if (!ttyRows?.some((row) => hasUnambiguousStartTime(row.startedAt, exitedAtMs))) {
      return 'exited'
    }
  }

  const graceMs = deps.graceMs ?? DESCENDANT_KILL_GRACE_MS
  const keepAlive = deps.keepAlive === true
  const startedAtMs = Date.now()
  const deadline = startedAtMs + (deps.verifyMs ?? DESCENDANT_KILL_VERIFY_MS)
  const signalled = new Map<number, SignalledIdentity>()
  let verdict: DescendantTreeVerdict = 'unverifiable'
  // Later rounds reach terminal-born work through its descent or group instead.
  ttyRows ??= await readTty()

  for (;;) {
    const capture = await readProcessTableBeforeDeadline(readTable, timeoutMs)
    if (capture) {
      prunePtySessionGroups(identity, capture.rows)
      observePtySessionIdentity(identity, capture.rows, capture.capturedAtMs)
      const targets = collectSessionSweepTargets({
        identity,
        rows: capture.rows,
        ...(ttyRows ? { ttyRows } : {}),
        ...(deps.selfPid === undefined ? {} : { selfPid: deps.selfPid })
      })
      ttyRows = undefined
      recordPtySessionGroups(identity, targets.ownedPgids, capture.capturedAtMs)
      if (targets.rows.length === 0) {
        return 'exited'
      }
      verdict = 'live'
      const escalate = Date.now() - startedAtMs >= graceMs
      signalTargets(targets.rows, capture.capturedAtMs, { escalate, signalled, sendSignal })
    }
    if (Date.now() >= deadline) {
      return capture ? verdict : 'unverifiable'
    }
    await waitForDelay(SWEEP_ROUND_INTERVAL_MS, keepAlive)
  }
}

function signalTargets(
  rows: readonly ProcessTableRow[],
  capturedAtMs: number,
  args: {
    escalate: boolean
    signalled: Map<number, SignalledIdentity>
    sendSignal: SignalSender
  }
): void {
  for (const row of rows) {
    const previous = args.signalled.get(row.pid)
    // Force-kill only what already refused a SIGTERM under this exact identity;
    // anything newly seen, or wearing a pid recycled since, starts over at SIGTERM.
    const sameIdentity = previous?.startedAt === row.startedAt && previous.pgid === row.pgid
    if (args.escalate && sameIdentity && hasUnambiguousStartIdentity(row, capturedAtMs)) {
      args.sendSignal(row.pid, 'SIGKILL')
      continue
    }
    if (!sameIdentity) {
      args.signalled.set(row.pid, { startedAt: row.startedAt, pgid: row.pgid })
    }
    args.sendSignal(row.pid, 'SIGTERM')
  }
}
