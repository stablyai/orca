import { normalizePtyTtyName } from './pty/posix-pty-foreground-group'
import { readTtyProcessTable, type TtyProcessTableReader } from './pty-session-tty-process-table'
import {
  collectDescendantsFromIndex,
  getProcessTableIndex,
  type ProcessIdentityRow
} from '../shared/process-table-index'
import type { ProcessTableRow } from './pty-process-table-parser'

/**
 * A process group this session was seen to own, and the last moment that was
 * verified.
 *
 * Why a time rather than the group id alone: a group id is only the pid of the
 * process that created it, and once every member exits the kernel may hand
 * that pid to an unrelated process that starts a group of its own. A process
 * born before `lastOwnedAtMs` cannot be that stranger — the id was still taken
 * by this session's group when it was born — so the sweep asks every
 * group-only claim for that proof.
 */
export type OwnedProcessGroup = {
  readonly pgid: number
  lastOwnedAtMs: number
}

/**
 * What Orca knows about the processes one PTY session owns, captured while the
 * session is alive so teardown still has coordinates after the root is reaped.
 *
 * A ppid walk answers only while the root lives: its descendants reparent to
 * pid 1 on exit, and a shell's job-control groups are unreachable from the
 * vacated PID. The terminal answers while Orca still holds the pty — on macOS
 * closing the master revokes the slave, so survivors show no terminal at all
 * afterwards. What outlives both is the set of process groups observed while
 * the session was whole, so that set is its durable claim on the work.
 */
export type PtySessionProcessIdentity = {
  readonly rootPid: number
  /** Controlling terminal as `ps -t` names it ('ttys003' / 'pts/3'), null when the session has none. */
  ttyName: string | null
  /** The root's `lstart`, learned from the first table that saw it alive. */
  rootStartedAt: string | null
  /** Groups this session owned when last observed; a group seen empty is dropped. */
  readonly ownedGroups: Map<number, OwnedProcessGroup>
  /** When the root was observed to exit; null while it lives. */
  rootExitedAtMs: number | null
}

export function createPtySessionProcessIdentity(args: {
  rootPid: number
  /** node-pty's slave device path, e.g. '/dev/ttys003'. */
  slavePath?: string | undefined
}): PtySessionProcessIdentity {
  const ttyName = args.slavePath ? normalizePtyTtyName(args.slavePath) : null
  return {
    rootPid: args.rootPid,
    ttyName: ttyName && ttyName.length > 0 ? ttyName : null,
    rootStartedAt: null,
    ownedGroups: new Map(),
    rootExitedAtMs: null
  }
}

/**
 * Folds a process-table capture into the identity. Call whenever a table is
 * read while the root may still be alive — spawn, the post-spawn re-read that
 * catches a child which called setsid/login_tty, and every sweep round.
 */
export function observePtySessionIdentity(
  identity: PtySessionProcessIdentity,
  rows: readonly ProcessTableRow[],
  capturedAtMs: number
): void {
  if (identity.rootExitedAtMs !== null) {
    // After exit, a row wearing the root's pid is a recycled stranger, never the root.
    return
  }
  let rootRow: ProcessTableRow | null = null
  for (const row of rows) {
    if (row.pid !== identity.rootPid) {
      continue
    }
    // A non-atomic read can hold both an old and a recycled root row; neither is a safe identity.
    if (rootRow) {
      return
    }
    rootRow = row
  }
  if (
    !rootRow ||
    (identity.rootStartedAt !== null && identity.rootStartedAt !== rootRow.startedAt)
  ) {
    return
  }
  identity.rootStartedAt = rootRow.startedAt
  recordPtySessionGroups(identity, [rootRow.pgid], capturedAtMs)
}

/**
 * Records groups that `ownedAtMs` shows this session owning. Only evidence of
 * ownership may call this — a descendant of the live root, or a process the
 * sweep has already verified — never a bare group id seen on some other row.
 */
export function recordPtySessionGroups(
  identity: PtySessionProcessIdentity,
  pgids: Iterable<number>,
  ownedAtMs: number
): void {
  for (const pgid of pgids) {
    // pid 1 and pgid 0 are never a session's own group; retaining them would target the world.
    if (!Number.isInteger(pgid) || pgid <= 1) {
      continue
    }
    const group = identity.ownedGroups.get(pgid)
    if (group) {
      group.lastOwnedAtMs = Math.max(group.lastOwnedAtMs, ownedAtMs)
    } else {
      identity.ownedGroups.set(pgid, { pgid, lastOwnedAtMs: ownedAtMs })
    }
  }
}

/**
 * Drops every group a whole-host capture shows with no member. An empty group
 * is gone for good, and its id is free for a stranger's group to take.
 */
export function prunePtySessionGroups(
  identity: PtySessionProcessIdentity,
  rows: readonly { pgid?: number | undefined }[]
): void {
  const live = new Set<number>()
  for (const row of rows) {
    // A capture tier without the group column cannot show a group empty.
    if (row.pgid === undefined) {
      return
    }
    live.add(row.pgid)
  }
  for (const pgid of identity.ownedGroups.keys()) {
    if (!live.has(pgid)) {
      identity.ownedGroups.delete(pgid)
    }
  }
}

/**
 * Records the process groups of everything currently descending from the root,
 * from a whole-host capture.
 *
 * This is the observation that makes a natural exit recoverable. A shell puts
 * each job in a group of its own, and once the job's ancestors die nothing
 * points back at it: not a ppid walk, and on macOS not the terminal either,
 * because closing the pty master revokes the slave and the survivor's
 * controlling terminal becomes none. The group is all that is left, and the
 * only time to learn it is while the tree is still whole.
 */
export function observeSessionDescendantGroups(
  identity: PtySessionProcessIdentity,
  rows: readonly (ProcessIdentityRow & { pgid?: number | undefined })[],
  capturedAtMs: number
): void {
  prunePtySessionGroups(identity, rows)
  if (identity.rootExitedAtMs !== null) {
    return
  }
  const index = getProcessTableIndex(rows)
  // Without the root in this capture the walk would descend from a recycled pid.
  if (!index.byPid.has(identity.rootPid)) {
    return
  }
  recordPtySessionGroups(
    identity,
    collectDescendantsFromIndex(index, identity.rootPid).flatMap((row) => row.pgid ?? []),
    capturedAtMs
  )
}

/**
 * Folds a capture of the session's own terminal in: the root's identity, plus
 * the group of anything descending from it there.
 *
 * Every row shares the session's terminal, but sharing a terminal is not
 * ownership — a daemon launched from that terminal shares it too — so a group
 * is only recorded for rows this capture can trace back to the root.
 */
export function observePtySessionTerminal(
  identity: PtySessionProcessIdentity,
  rows: readonly ProcessTableRow[],
  capturedAtMs: number
): void {
  observePtySessionIdentity(identity, rows, capturedAtMs)
  if (identity.rootExitedAtMs !== null) {
    return
  }
  const index = getProcessTableIndex(rows)
  if (!index.byPid.has(identity.rootPid)) {
    return
  }
  recordPtySessionGroups(
    identity,
    collectDescendantsFromIndex(index, identity.rootPid).map((row) => row.pgid),
    capturedAtMs
  )
}

/** Closes the window in which this session could still acquire members on its tty. */
export function markPtySessionRootExited(
  identity: PtySessionProcessIdentity,
  atMs = Date.now()
): void {
  identity.rootExitedAtMs ??= atMs
}

/**
 * Long enough for a shell that re-execs, or a child that calls setsid/login_tty,
 * to have settled into the group it will keep; short enough that a session which
 * exits almost immediately is still described by something.
 */
export const POST_SPAWN_IDENTITY_CAPTURE_DELAY_MS = 750

export type IdentityCaptureDeps = {
  readTtyTable?: TtyProcessTableReader
  delayMs?: number
  platform?: NodeJS.Platform
}

/**
 * Opens a session's identity: its terminal from the spawn itself, then its own
 * start time and process groups from one read of its own terminal shortly after.
 *
 * That read is the only moment a naturally-exiting session can learn its own
 * coordinates — by teardown the root is reaped and nothing left behind points
 * back at it. It needs no cancelling: folding a capture in is already a no-op
 * once the root has exited.
 */
export function openPtySessionIdentity(
  subprocess: { pid: number; slavePath?: string | undefined },
  deps: IdentityCaptureDeps = {}
): PtySessionProcessIdentity {
  const identity = createPtySessionProcessIdentity({
    rootPid: subprocess.pid,
    ...(subprocess.slavePath === undefined ? {} : { slavePath: subprocess.slavePath })
  })
  // No controlling terminal means no session to re-find: the root pid on its own
  // is not evidence of ownership, so recording what wears it would be a guess.
  if ((deps.platform ?? process.platform) === 'win32' || identity.ttyName === null) {
    return identity
  }
  const readTtyTable = deps.readTtyTable ?? readTtyProcessTable
  const timer = setTimeout(() => {
    void readTtyTable(identity.ttyName ?? '').then(
      (capture) => {
        if (capture) {
          observePtySessionTerminal(identity, capture.rows, capture.capturedAtMs)
        }
      },
      () => {
        // An unreadable terminal leaves the identity as spawn described it.
      }
    )
  }, deps.delayMs ?? POST_SPAWN_IDENTITY_CAPTURE_DELAY_MS)
  timer.unref?.()
  return identity
}
