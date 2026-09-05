import {
  DESCENDANT_KILL_GRACE_MS,
  DESCENDANT_SNAPSHOT_TIMEOUT_MS,
  hasUnambiguousStartIdentity,
  readProcessTable,
  readProcessTableBeforeDeadline,
  sendDescendantSignal,
  type DescendantSnapshot,
  type ProcessTableRow,
  type TerminateDeps
} from './pty-descendant-termination'

export const DESCENDANT_KILL_VERIFY_MS = 3_500

function waitForDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function matchingSnapshotRows(
  snapshot: DescendantSnapshot,
  table: readonly ProcessTableRow[],
  rejectDuplicatePids = false
): ProcessTableRow[] {
  const expected = new Map(snapshot.descendants.map((row) => [row.pid, row]))
  const rowsByPid = new Map<number, ProcessTableRow[]>()
  for (const live of table) {
    const rows = rowsByPid.get(live.pid)
    if (rows) {
      rows.push(live)
    } else {
      rowsByPid.set(live.pid, [live])
    }
  }
  return [...expected.entries()].flatMap(([pid, row]) => {
    const rows = rowsByPid.get(pid)
    if (rejectDuplicatePids && rows?.length !== 1) {
      // Duplicate PID rows make this non-atomic process-table read ambiguous;
      // never signal or count either identity as proof of liveness.
      return []
    }
    return (rows ?? []).filter((live) => live.startedAt === row.startedAt && live.pgid === row.pgid)
  })
}

function hasDuplicateSnapshotPids(
  snapshot: DescendantSnapshot,
  table: readonly ProcessTableRow[]
): boolean {
  const expected = new Set(snapshot.descendants.map((row) => row.pid))
  const counts = new Map<number, number>()
  for (const live of table) {
    if (expected.has(live.pid)) {
      counts.set(live.pid, (counts.get(live.pid) ?? 0) + 1)
    }
  }
  return [...counts.values()].some((count) => count > 1)
}

type VerificationDeps = TerminateDeps & {
  verifyMs?: number
  /** Revalidate identities before signaling; used by Claude's close proof. */
  requireIdentityBeforeSignal?: boolean
}

/**
 * Orca's verdict vocabulary for a snapshotted tree, with no synonyms: `live` is
 * an identity-matched descendant still observed at the deadline; `unverifiable`
 * is a table that could not be read, which is never evidence either way.
 */
export type DescendantTreeVerdict = 'exited' | 'live' | 'unverifiable'

/** An unreadable process table is never proof that a stopped descendant exited. */
export async function terminateDescendantSnapshotAndWait(
  snapshot: DescendantSnapshot,
  deps: VerificationDeps = {}
): Promise<boolean> {
  return (await terminateDescendantSnapshotWithVerdict(snapshot, deps)) === 'exited'
}

/** Signals the snapshot, then reports what the last table read observed. */
export async function terminateDescendantSnapshotWithVerdict(
  snapshot: DescendantSnapshot,
  deps: VerificationDeps = {}
): Promise<DescendantTreeVerdict> {
  const sendSignal = deps.sendSignal ?? sendDescendantSignal
  const readTable = deps.readTable ?? readProcessTable
  const graceMs = deps.graceMs ?? DESCENDANT_KILL_GRACE_MS
  const verifyMs = deps.verifyMs ?? DESCENDANT_KILL_VERIFY_MS
  const deadline = Date.now() + verifyMs
  let forced = false
  let signalled = !deps.requireIdentityBeforeSignal
  let missingObservations = 0
  if (signalled) {
    for (const row of snapshot.descendants) {
      sendSignal(row.pid, 'SIGTERM')
    }
  }
  while (Date.now() < deadline) {
    const capture = await readProcessTableBeforeDeadline(
      readTable,
      deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
    )
    // A read that missed its own deadline is not an answer, and surrendering on
    // the first slow one spends none of the window this verification was given:
    // on a loaded host that reported a tree unverifiable without ever seeing it.
    if (capture) {
      if (deps.requireIdentityBeforeSignal && hasDuplicateSnapshotPids(snapshot, capture.rows)) {
        // A duplicate target pid is an ambiguous non-atomic read. Do not signal
        // either row and do not turn that uncertainty into an exited verdict.
        await waitForDelay(50)
        continue
      }
      const live = matchingSnapshotRows(snapshot, capture.rows, deps.requireIdentityBeforeSignal)
      if (live.length === 0) {
        // Before a signal has been sent, an empty identity match means the
        // snapshotted descendants already exited or were replaced. Signalling
        // those old numeric pids would be unsafe.
        if (deps.requireIdentityBeforeSignal) {
          // A single process-table read can race a fork or return a partial
          // view; require two bounded absences before claiming the tree gone.
          missingObservations += 1
          if (missingObservations < 2) {
            await waitForDelay(50)
            continue
          }
        }
        return 'exited'
      }
      missingObservations = 0
      if (!signalled) {
        // Revalidate every identity immediately before the first signal. A PID
        // can be recycled between the original walk and close, so never signal
        // from the stale snapshot alone.
        for (const row of live) {
          sendSignal(row.pid, 'SIGTERM')
        }
        signalled = true
      }
      if (!forced && Date.now() >= deadline - verifyMs + graceMs) {
        forced = true
        for (const row of live) {
          // A row a walk re-derived from a live root is ours whatever second it
          // was born in, which start time alone can never establish for one born
          // in its own capture second. Rows no walk re-derived still answer to
          // the second-resolution fence, which is all the evidence they have.
          // Scoped to the identity-revalidating callers; the same argument holds
          // for the rest, but widening it is a deliberate change of its own.
          if (
            (deps.requireIdentityBeforeSignal === true &&
              snapshot.reDerivedPids?.has(row.pid) === true) ||
            hasUnambiguousStartIdentity(
              row,
              snapshot.capturedAtMsByPid?.[String(row.pid)] ?? snapshot.capturedAtMs
            )
          ) {
            sendSignal(row.pid, 'SIGKILL')
          }
        }
      }
    }
    await waitForDelay(50)
  }
  const finalCapture = await readProcessTableBeforeDeadline(
    readTable,
    deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
  )
  if (!finalCapture) {
    return 'unverifiable'
  }
  if (deps.requireIdentityBeforeSignal && hasDuplicateSnapshotPids(snapshot, finalCapture.rows)) {
    return 'unverifiable'
  }
  const finalLive = matchingSnapshotRows(
    snapshot,
    finalCapture.rows,
    deps.requireIdentityBeforeSignal
  )
  if (finalLive.length > 0) {
    return 'live'
  }
  return deps.requireIdentityBeforeSignal && missingObservations < 2 ? 'unverifiable' : 'exited'
}
