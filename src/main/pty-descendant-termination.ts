import { execFile } from 'node:child_process'
import {
  runWindowsSweepWithDeadline,
  type WindowsSweepDeps
} from './pty-descendant-sweep-budget'

export const DESCENDANT_KILL_GRACE_MS = 2_000
export const DESCENDANT_SNAPSHOT_TIMEOUT_MS = 1_000
// Why: a full process table on a busy host can exceed execFile's 1MB default;
// truncation would silently drop descendants from the snapshot.
const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024

export type ProcessTableRow = {
  pid: number
  ppid: number
  pgid: number
  /** ps lstart text, kept verbatim. Delayed SIGKILL additionally requires an
   * unambiguous capture-second boundary and matching pgid. */
  startedAt: string
}

export type DescendantSnapshot = {
  rootPgid: number | null
  descendants: ProcessTableRow[]
  /** Wall-clock boundary for deciding whether ps's second-resolution lstart
   *  can safely distinguish this process from a later PID reuse. */
  capturedAtMs: number
}

export type ProcessTableCapture = {
  rows: ProcessTableRow[]
  /** Start boundary of the scan that produced rows, never a later consumer's time. */
  capturedAtMs: number
}

export type ProcessTableReader = (timeoutMs?: number) => Promise<ProcessTableCapture>
export type SignalSender = (pid: number, signal: NodeJS.Signals) => void

export function parseProcessTable(psOutput: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = []
  for (const line of psOutput.split('\n')) {
    // lstart itself contains spaces ("Mon Jul 13 12:54:47 2026"), so only the
    // three leading numeric columns are positional.
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/)
    if (!match) {
      continue
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAt: match[4]
    })
  }
  return rows
}

function readFreshProcessTable(
  timeoutMs = DESCENDANT_SNAPSHOT_TIMEOUT_MS
): Promise<ProcessTableCapture> {
  // Why: identity safety must use the boundary before ps starts. Stamping the
  // result later could make a capture-second PID look safe after a rollover.
  const capturedAtMs = Date.now()
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,pgid=,lstart='],
      {
        maxBuffer: PS_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        // Why: ps localizes lstart, but delayed identity checks must parse it
        // identically for every user locale.
        env: { ...process.env, LANG: 'C', LC_ALL: 'C' }
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ rows: parseProcessTable(stdout), capturedAtMs })
      }
    )
  })
}

/** Coalesces same-turn teardown bursts but never serves a completed or already
 * started scan to a later request, because stale PIDs are unsafe to signal. */
export function createProcessTableSnapshotReader(
  readFresh: ProcessTableReader
): ProcessTableReader {
  let queued: { promise: Promise<ProcessTableCapture>; started: boolean } | null = null

  return (timeoutMs) => {
    if (queued && !queued.started) {
      return queued.promise
    }

    const entry: { promise: Promise<ProcessTableCapture>; started: boolean } = {
      promise: Promise.resolve(undefined as never),
      started: false
    }
    entry.promise = Promise.resolve().then(() => {
      // Why: a later caller's deadline starts when it requests a fresh table.
      // Waiting behind an older scan can consume that entire budget, then run
      // this subprocess after nobody can use its result.
      entry.started = true
      return readFresh(timeoutMs)
    })
    queued = entry
    const clearQueued = (): void => {
      if (queued === entry) {
        queued = null
      }
    }
    void entry.promise.then(clearQueued, clearQueued)
    return entry.promise
  }
}

export const readProcessTable = createProcessTableSnapshotReader(readFreshProcessTable)

export function readProcessTableBeforeDeadline(
  readTable: ProcessTableReader,
  timeoutMs: number,
  /** Keep this deadline timer ref'd instead of the default unref'd. Only a
   *  caller that awaits the full escalation (daemon shutdown) should set
   *  this — otherwise Node's event loop can see no ref'd work left and let
   *  the process exit before the deadline this promise depends on fires. */
  keepAlive = false
): Promise<ProcessTableCapture | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (capture: ProcessTableCapture | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(capture)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    if (!keepAlive) {
      timer.unref?.()
    }
    try {
      void readTable(timeoutMs).then(
        (rows) => finish(rows),
        () => finish(null)
      )
    } catch {
      finish(null)
    }
  })
}

export function collectDescendantRows(
  rootPid: number,
  table: ProcessTableRow[],
  capturedAtMs = Date.now()
): DescendantSnapshot {
  const childrenByPpid = new Map<number, ProcessTableRow[]>()
  let rootRow: ProcessTableRow | null = null
  for (const row of table) {
    if (row.pid === rootPid) {
      rootRow = row
      continue
    }
    const siblings = childrenByPpid.get(row.ppid)
    if (siblings) {
      siblings.push(row)
    } else {
      childrenByPpid.set(row.ppid, [row])
    }
  }
  // Why: a ppid walk is only meaningful while the root is alive in this snapshot.
  // An absent root has already exited — its real descendants reparent to pid 1 and
  // become unreachable by ppid, so any rows still pointing at the vacated PID are a
  // PID-reuse coincidence. Sweeping them could signal an unrelated process, so bail.
  if (!rootRow) {
    return { rootPgid: null, descendants: [], capturedAtMs }
  }
  const descendants: ProcessTableRow[] = []
  const queue = [rootPid]
  const visited = new Set(queue)
  for (let nextIndex = 0; nextIndex < queue.length; nextIndex += 1) {
    const pid = queue[nextIndex]
    for (const child of childrenByPpid.get(pid) ?? []) {
      // Why: ps is not an atomic snapshot. PID reuse can produce duplicate or
      // cyclic-looking rows, which must not hang the Electron main thread.
      if (visited.has(child.pid)) {
        continue
      }
      visited.add(child.pid)
      descendants.push(child)
      queue.push(child.pid)
    }
  }
  return { rootPgid: rootRow.pgid, descendants, capturedAtMs }
}

type SnapshotDeps = {
  readTable?: ProcessTableReader
  platform?: NodeJS.Platform
  timeoutMs?: number
}

/**
 * Snapshots a PTY root's live descendant tree. Must run BEFORE the root is
 * signalled: once the root dies, surviving descendants reparent to pid 1 and
 * can no longer be found by a ppid walk. Resolves null (never rejects) on
 * Windows, ps failure, or timeout — callers then degrade to shell-only kill
 * on POSIX, or identity-gated Windows `taskkill /T` via killWithDescendantSweep.
 */
export async function captureDescendantSnapshot(
  rootPid: number,
  deps: SnapshotDeps = {}
): Promise<DescendantSnapshot | null> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32' || !Number.isInteger(rootPid) || rootPid <= 0) {
    return null
  }
  const readTable = deps.readTable ?? readProcessTable
  const timeoutMs = deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
  // Why both layers: the deadline keeps injected/custom readers bounded while
  // the production execFile timeout actually kills a wedged ps subprocess.
  const capture = await readProcessTableBeforeDeadline(readTable, timeoutMs)
  if (!capture) {
    return null
  }
  return collectDescendantRows(rootPid, capture.rows, capture.capturedAtMs)
}

type KillSweepDeps = SnapshotDeps & TerminateDeps & WindowsSweepDeps

/**
 * Standard agent-session kill sequencing.
 * - POSIX: snapshot the descendant tree, signal members, then killRoot.
 * - Windows: see runWindowsSweepWithDeadline — the PTY's job object first
 *   (exact, no probe), else the identity-gated `taskkill /T /F` fallback.
 * Callers must not signal the root before this runs on POSIX — a dead root's
 * descendants reparent to pid 1 and become unfindable. Snapshot failure
 * degrades to killRoot alone on POSIX. killRoot always runs right after the
 * SIGTERM sweep (POSIX) or the identity probe (Windows/WSL fallback),
 * regardless of `awaitEscalation` — only the promise this function returns,
 * not killRoot's own timing, is delayed by it.
 */
export async function killWithDescendantSweep(
  rootPid: number,
  killRoot: () => void,
  deps: KillSweepDeps = {}
): Promise<void> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') {
    // Why dispatched out: the Windows fallback carries probe scaling, an
    // escalation race, and a killRoot deadline that do not fit this module's
    // line budget. POSIX needs none of that — its snapshot, grace window,
    // and re-read are already constant-bounded.
    await runWindowsSweepWithDeadline(rootPid, killRoot, deps)
    return
  }

  const snapshot = await captureDescendantSnapshot(rootPid, deps)
  let escalation: Promise<void> = Promise.resolve()
  try {
    // Signal the captured descendants while their parent links still exist;
    // killing the root first creates a reparent/PID-reuse window.
    if (snapshot && (deps.ownsRoot?.() ?? true)) {
      escalation = terminateDescendantSnapshot(snapshot, deps)
    }
  } finally {
    killRoot()
  }
  if (deps.awaitEscalation) {
    await escalation
  }
}

export function sendDescendantSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    /* already gone */
  }
}

export type TerminateDeps = {
  readTable?: ProcessTableReader
  sendSignal?: SignalSender
  graceMs?: number
  timeoutMs?: number
  /**
   * On POSIX (consumed directly by terminateDescendantSnapshot): await the
   * grace-window SIGKILL escalation before resolving, instead of leaving it
   * on its own unref'd timer. A caller that force-exits the process right
   * after this resolves (daemon shutdown) would otherwise drop that timer
   * mid-flight and leave SIGTERM-ignoring descendants alive. Off by default
   * because it adds up to ~DESCENDANT_KILL_GRACE_MS + DESCENDANT_SNAPSHOT_TIMEOUT_MS
   * of latency, which a long-lived process's fire-and-forget close
   * (interactive tab close) does not need to pay.
   *
   * Also keeps the grace-window timer and its escalation deadline read
   * ref'd instead of unref'd: an awaiting caller needs Node's event loop to
   * actually stay alive for these to fire, not just a promise nobody's loop
   * is obligated to keep pending. Fire-and-forget callers must leave this
   * unset so an otherwise-idle long-lived process isn't held open by it.
   *
   * On Windows (consumed by killWithDescendantSweep via this same field):
   * await the `taskkill /T /F` escalation kicked off after the identity
   * probe, for the same reason — killRoot itself never waits on it either way.
   */
  awaitEscalation?: boolean
}

export function hasUnambiguousStartIdentity(row: ProcessTableRow, capturedAtMs: number): boolean {
  const startedAtMs = Date.parse(row.startedAt)
  if (!Number.isFinite(startedAtMs)) {
    return false
  }
  // ps lstart is second-resolution. A process born in the capture second can
  // be replaced by a different process with the same displayed timestamp.
  return startedAtMs < Math.floor(capturedAtMs / 1_000) * 1_000
}

/**
 * Terminates a snapshotted descendant tree: SIGTERM every descendant now,
 * reaching detached-pgid children the PTY's SIGHUP cannot, then after a grace
 * window SIGKILL identity-safe survivors. Processes born in the capture second
 * are not escalated because ps cannot distinguish same-second PID reuse.
 * The returned promise settles once that escalation check finishes (or is
 * skipped for an empty tree); its timer stays unref'd — unless `awaitEscalation`
 * is set, for a caller (daemon shutdown) that awaits this promise and needs
 * Node's event loop kept alive long enough for it to actually settle — so a
 * caller that never awaits it does not keep an otherwise-idle process alive.
 */
export function terminateDescendantSnapshot(
  snapshot: DescendantSnapshot,
  deps: TerminateDeps = {}
): Promise<void> {
  const sendSignal = deps.sendSignal ?? sendDescendantSignal
  const readTable = deps.readTable ?? readProcessTable
  const keepAlive = deps.awaitEscalation ?? false
  for (const row of snapshot.descendants) {
    sendSignal(row.pid, 'SIGTERM')
  }
  if (snapshot.descendants.length === 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      void readProcessTableBeforeDeadline(
        readTable,
        deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS,
        keepAlive
      ).then((capture) => {
        if (capture) {
          const expectedPids = new Set(snapshot.descendants.map((row) => row.pid))
          const liveTargets = new Map<number, ProcessTableRow | null>()
          // Why: a process table may be large, while one agent's descendants are
          // normally few. Index only signal targets instead of duplicating every row.
          for (const live of capture.rows) {
            if (expectedPids.has(live.pid)) {
              // Duplicate PID rows make identity ambiguous, so never escalate them.
              liveTargets.set(live.pid, liveTargets.has(live.pid) ? null : live)
            }
          }
          for (const row of snapshot.descendants) {
            const live = liveTargets.get(row.pid)
            if (
              hasUnambiguousStartIdentity(row, snapshot.capturedAtMs) &&
              live?.startedAt === row.startedAt &&
              live.pgid === row.pgid
            ) {
              sendSignal(row.pid, 'SIGKILL')
            }
          }
        }
        resolve()
      })
    }, deps.graceMs ?? DESCENDANT_KILL_GRACE_MS)
    if (!keepAlive) {
      timer.unref?.()
    }
  })
}
