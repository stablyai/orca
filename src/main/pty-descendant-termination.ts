import { execFile } from 'node:child_process'
import { matchingSignalTargets } from './pty-descendant-signal-targets'
import {
  readProcessTableBeforeDeadline,
  readProcessTableWithRetries
} from './pty-process-table-deadline'
export { readProcessTableBeforeDeadline } from './pty-process-table-deadline'
import { parseProcessTable, type ProcessTableRow } from './pty-process-table-parser'

export { parseProcessTable, type ProcessTableRow } from './pty-process-table-parser'
export {
  hasUnambiguousStartIdentity,
  hasUnambiguousStartTime
} from './pty-descendant-signal-targets'
import { runWindowsSweepWithDeadline, type WindowsSweepDeps } from './pty-descendant-sweep-budget'

export const DESCENDANT_KILL_GRACE_MS = 2_000
export const DESCENDANT_SNAPSHOT_TIMEOUT_MS = 1_000
// Why: a full process table on a busy host can exceed execFile's 1MB default;
// truncation would silently drop descendants from the snapshot.
const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024

export type PosixProcessIdentity = Pick<ProcessTableRow, 'pid' | 'startedAt'>

export type DescendantSnapshot = {
  /** Identity of the root observed in the same process-table capture. */
  root?: PosixProcessIdentity
  rootPgid: number | null
  descendants: ProcessTableRow[]
  /** Wall-clock boundary for an unmerged snapshot (or legacy callers). */
  capturedAtMs: number
  /** Per-PID identity boundaries for merged captures. */
  capturedAtMsByPid?: Readonly<Record<string, number>>
  /**
   * PIDs this walk re-derived from a live root. A ppid walk only reaches what
   * the root actually parents, so membership is proof of ownership that owes
   * nothing to `lstart`'s one-second resolution: a stranger would have to have
   * been forked into our own tree, and then it is not a stranger. Rows a merge
   * retained from an earlier walk are absent, and still answer to start time.
   */
  reDerivedPids?: ReadonlySet<number>
}

export type ProcessTableCapture = {
  rows: ProcessTableRow[]
  /** Start boundary of the scan that produced rows, never a later consumer's time. */
  capturedAtMs: number
}

export type ProcessTableReader = (timeoutMs?: number) => Promise<ProcessTableCapture>
export type SignalSender = (pid: number, signal: NodeJS.Signals) => void

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

export function collectDescendantRows(
  rootPid: number,
  table: ProcessTableRow[],
  capturedAtMs = Date.now()
): DescendantSnapshot {
  const childrenByPpid = new Map<number, ProcessTableRow[]>()
  let rootRow: ProcessTableRow | null = null
  let duplicateRoot = false
  for (const row of table) {
    if (row.pid === rootPid) {
      // A non-atomic process-table read can contain both an old and a recycled
      // root row. There is no safe identity to retain in that case.
      duplicateRoot = rootRow !== null
      rootRow ??= row
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
  if (!rootRow || duplicateRoot) {
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
  return {
    root: { pid: rootRow.pid, startedAt: rootRow.startedAt },
    rootPgid: rootRow.pgid,
    descendants,
    capturedAtMs,
    reDerivedPids: new Set(descendants.map((row) => row.pid))
  }
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

type KillSweepDeps = Omit<SnapshotDeps & TerminateDeps & WindowsSweepDeps, 'awaitEscalation'> & {
  /** Shutdown can retain the owner until descendant verification finishes. */
  terminateDescendants?: (snapshot: DescendantSnapshot) => void | Promise<unknown>
  awaitEscalation?: boolean | (() => boolean)
}

/**
 * Standard agent-session kill sequencing.
 * - POSIX: snapshot the descendant tree, signal members, then killRoot.
 * - Windows: see runWindowsSweepWithDeadline — the PTY's job object first
 *   (exact, no probe), else the identity-gated `taskkill /T /F` fallback.
 * Callers must not signal the root before this runs on POSIX — a dead root's
 * descendants reparent to pid 1 and become unfindable. Snapshot failure
 * degrades to killRoot alone on POSIX. The default sweep kills the root after
 * identity-checked SIGTERM, before grace. A custom shutdown verifier with
 * awaitEscalation retains the root until its descendant proof finishes.
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
  const awaitEscalation =
    typeof deps.awaitEscalation === 'function' ? deps.awaitEscalation() : deps.awaitEscalation
  try {
    // Signal the captured descendants while their parent links still exist;
    // killing the root first creates a reparent/PID-reuse window.
    if (snapshot && (deps.ownsRoot?.() ?? true)) {
      if (deps.terminateDescendants) {
        const descendants = deps.terminateDescendants(snapshot)
        if (awaitEscalation) {
          await descendants
        }
      } else {
        const started = await startDescendantTermination(
          snapshot,
          { ...deps, awaitEscalation },
          deps.ownsRoot
        )
        escalation = started.escalation
      }
    }
  } finally {
    killRoot()
  }
  if (awaitEscalation) {
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
  /** Independent budget for each signal phase, including transient-read retries. */
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
   * Also keeps both identity-read deadlines and the grace-window timer
   * ref'd instead of unref'd: an awaiting caller needs Node's event loop to
   * actually stay alive for these to fire, not just a promise nobody's loop
   * is obligated to keep pending. Fire-and-forget callers must leave this
   * unset so an otherwise-idle long-lived process isn't held open by it.
   *
   * On Windows (consumed by killWithDescendantSweep via this same field):
   * keep deadline timers alive while awaiting bounded tree termination. The
   * Windows root remains alive until that termination completes or times out.
   */
  awaitEscalation?: boolean
}

/** Revalidate before both signals; the promise includes the grace-window escalation. */
export async function terminateDescendantSnapshot(
  snapshot: DescendantSnapshot,
  deps: TerminateDeps = {}
): Promise<void> {
  const { escalation } = await startDescendantTermination(snapshot, deps)
  await escalation
}

// Box the escalation promise so callers can kill the root after SIGTERM, before grace.
async function startDescendantTermination(
  snapshot: DescendantSnapshot,
  deps: TerminateDeps,
  ownsRoot?: () => boolean
): Promise<{ escalation: Promise<void> }> {
  const skip = { escalation: Promise.resolve() }
  if (snapshot.descendants.length === 0) {
    return skip
  }
  const sendSignal = deps.sendSignal ?? sendDescendantSignal
  const readTable = deps.readTable ?? readProcessTable
  const keepAlive = deps.awaitEscalation ?? false
  const timeoutMs = deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
  const graceMs = deps.graceMs ?? DESCENDANT_KILL_GRACE_MS
  // Daemon shutdown supplies its own verifier; interactive escalation gets a full fresh-read budget.
  const initial = await readProcessTableWithRetries(readTable, timeoutMs, keepAlive, ownsRoot)
  if (!initial || !(ownsRoot?.() ?? true)) {
    return skip
  }
  const descendants = matchingSignalTargets(snapshot, initial.rows)
  if (descendants.length === 0) {
    return skip
  }
  for (const row of descendants) {
    sendSignal(row.pid, 'SIGTERM')
  }
  const validatedSnapshot = { ...snapshot, descendants }
  const escalation = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      void readProcessTableWithRetries(readTable, timeoutMs, keepAlive).then((capture) => {
        if (capture) {
          for (const row of matchingSignalTargets(validatedSnapshot, capture.rows)) {
            sendSignal(row.pid, 'SIGKILL')
          }
        }
        resolve()
      })
    }, graceMs)
    if (!keepAlive) {
      timer.unref?.()
    }
  })
  return { escalation }
}
