import {
  DESCENDANT_KILL_GRACE_MS,
  DESCENDANT_SNAPSHOT_TIMEOUT_MS,
  collectDescendantRows,
  hasUnambiguousStartIdentity,
  readProcessTable,
  readProcessTableBeforeDeadline,
  sendDescendantSignal,
  type DescendantSnapshot,
  type ProcessTableCapture,
  type ProcessTableRow,
  type TerminateDeps
} from './pty-descendant-termination'

export const DESCENDANT_KILL_VERIFY_MS = 3_500

function waitForDelay(ms: number, keepAlive = false): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (!keepAlive) {
      timer.unref?.()
    }
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
    if (!expected.has(live.pid)) {
      continue
    }
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
      // Non-atomic reads can contain duplicate PIDs; neither row proves identity.
      return []
    }
    return (rows ?? []).filter((live) => live.startedAt === row.startedAt && live.pgid === row.pgid)
  })
}

function rederiveSnapshotPids(
  snapshot: DescendantSnapshot,
  capture: ProcessTableCapture
): ReadonlySet<number> | undefined {
  if (!snapshot.root) {
    return
  }
  const uniqueRows = new Map<number, ProcessTableRow | null>()
  for (const row of capture.rows) {
    uniqueRows.set(row.pid, uniqueRows.has(row.pid) ? null : row)
  }
  const fresh = collectDescendantRows(
    snapshot.root.pid,
    [...uniqueRows.values()].filter((row): row is ProcessTableRow => row !== null),
    capture.capturedAtMs
  )
  if (fresh.root?.startedAt === snapshot.root.startedAt && fresh.rootPgid === snapshot.rootPgid) {
    return fresh.reDerivedPids
  }
  return undefined
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
  /** A departing daemon must finish escalation after its last PTY exits. */
  keepAlive?: boolean
  /** Revalidate identities before signaling; used by Claude's close proof. */
  requireIdentityBeforeSignal?: boolean
}

/** live requires an identity match; unverifiable means the available observations cannot prove exit or liveness. */
export type DescendantTreeVerdict = 'exited' | 'live' | 'unverifiable'

/** An unreadable process table is never proof that a stopped descendant exited. */
export async function terminateDescendantSnapshotAndWait(
  snapshot: DescendantSnapshot,
  deps: VerificationDeps = {}
): Promise<boolean> {
  return (await terminateDescendantSnapshotWithVerdict(snapshot, deps)) === 'exited'
}

export async function terminateDescendantSnapshotWithVerdict(
  snapshot: DescendantSnapshot,
  deps: VerificationDeps = {}
): Promise<DescendantTreeVerdict> {
  const sendSignal = deps.sendSignal ?? sendDescendantSignal
  const readTable = deps.readTable ?? readProcessTable
  const graceMs = deps.graceMs ?? DESCENDANT_KILL_GRACE_MS
  const verifyMs = deps.verifyMs ?? DESCENDANT_KILL_VERIFY_MS
  const deadline = Date.now() + verifyMs
  const forced = new Set<number>()
  const signalled = new Set<number>()
  const missingObservations = new Map(snapshot.descendants.map((row) => [row.pid, 0]))
  // Absence counts only from reads started after the last sighting; older in-flight scans can miss new forks.
  const lastSeenAtMs = new Map(
    snapshot.descendants.map((row) => [
      row.pid,
      snapshot.capturedAtMsByPid?.[String(row.pid)] ?? snapshot.capturedAtMs
    ])
  )
  const recordIdentityObservation = (
    capture: ProcessTableCapture,
    live: readonly ProcessTableRow[]
  ): void => {
    for (const row of snapshot.descendants) {
      const lastSeen = lastSeenAtMs.get(row.pid) ?? Infinity
      if (live.some((current) => current.pid === row.pid)) {
        missingObservations.set(row.pid, 0)
        // A read that started earlier but resolved later must not move the sighting back.
        lastSeenAtMs.set(row.pid, Math.max(lastSeen, capture.capturedAtMs))
      } else if (capture.capturedAtMs > lastSeen) {
        missingObservations.set(row.pid, (missingObservations.get(row.pid) ?? 0) + 1)
      }
    }
  }
  const provenAbsent = (): boolean =>
    snapshot.descendants.every((row) => (missingObservations.get(row.pid) ?? 0) >= 2)
  if (!deps.requireIdentityBeforeSignal) {
    for (const row of snapshot.descendants) {
      sendSignal(row.pid, 'SIGTERM')
      signalled.add(row.pid)
    }
  }
  while (Date.now() < deadline) {
    const capture = await readProcessTableBeforeDeadline(
      readTable,
      deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
    )
    // Retry slow reads within the verification window; a missed deadline supplies no evidence.
    if (capture) {
      if (deps.requireIdentityBeforeSignal && hasDuplicateSnapshotPids(snapshot, capture.rows)) {
        // Duplicate target PIDs prove neither ownership nor exit; do not signal either row.
        await waitForDelay(50, deps.keepAlive)
        continue
      }
      const live = matchingSnapshotRows(snapshot, capture.rows, deps.requireIdentityBeforeSignal)
      if (deps.requireIdentityBeforeSignal) {
        recordIdentityObservation(capture, live)
      }
      if (live.length === 0) {
        // Require two fresh absences per identity before declaring exit without signalling stale PIDs.
        if (deps.requireIdentityBeforeSignal && !provenAbsent()) {
          await waitForDelay(50, deps.keepAlive)
          continue
        }
        return 'exited'
      }
      for (const row of live) {
        if (!signalled.has(row.pid)) {
          sendSignal(row.pid, 'SIGTERM')
          signalled.add(row.pid)
        }
      }
      if (Date.now() >= deadline - verifyMs + graceMs) {
        const pending = live.filter((row) => !forced.has(row.pid))
        const freshPids =
          deps.requireIdentityBeforeSignal &&
          pending.some(
            (row) =>
              snapshot.reDerivedPids?.has(row.pid) === true &&
              !hasUnambiguousStartIdentity(
                row,
                snapshot.capturedAtMsByPid?.[String(row.pid)] ?? snapshot.capturedAtMs
              )
          )
            ? rederiveSnapshotPids(snapshot, capture)
            : undefined
        for (const row of pending) {
          // Birth-second identity needs ownership from this read, not a stale walk.
          if (
            (deps.requireIdentityBeforeSignal === true &&
              snapshot.reDerivedPids?.has(row.pid) === true &&
              freshPids?.has(row.pid) === true) ||
            hasUnambiguousStartIdentity(
              row,
              snapshot.capturedAtMsByPid?.[String(row.pid)] ?? snapshot.capturedAtMs
            )
          ) {
            sendSignal(row.pid, 'SIGKILL')
            forced.add(row.pid)
          }
        }
      }
    }
    await waitForDelay(50, deps.keepAlive)
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
  if (deps.requireIdentityBeforeSignal) {
    recordIdentityObservation(finalCapture, finalLive)
    return provenAbsent() ? 'exited' : 'unverifiable'
  }
  return 'exited'
}
