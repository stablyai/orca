import {
  captureDescendantSnapshot,
  collectDescendantRows,
  hasUnambiguousStartIdentity,
  hasUnambiguousStartTime,
  readProcessTable,
  sendDescendantSignal,
  type SignalSender
} from '../pty/process-retirement/pty-descendant-termination'
import {
  terminateDescendantSnapshotWithVerdict,
  type DescendantTreeVerdict
} from '../pty/process-retirement/pty-descendant-exit-verification'
import {
  DESCENDANT_SNAPSHOT_TIMEOUT_MS,
  type ProcessTableReader
} from '../pty/process-retirement/pty-descendant-fresh-table'
import { sameProviderProcess, type ProviderGroupIdentity } from './provider-group-orphan-guard'
import { readPosixProcessRow, type ProcessRowRead } from './provider-process-row-read'
import type { publishProviderOwnership } from './provider-ownership-journal'

export class ProviderFaultOwnership {
  task?: Promise<void>
  private pending = false
  private reapQueued = false

  stopAfterCapture(
    ownership: Promise<Awaited<ReturnType<typeof publishProviderOwnership>>> | undefined,
    stop: () => void
  ): void {
    if (!this.task) {
      this.pending = true
      this.task = Promise.resolve(ownership)
        .then(async (registered) => {
          if (registered) {
            await terminateProviderFaultDescendants(registered.identity)
          }
        })
        .catch(() => {})
        .finally(() => {
          this.pending = false
        })
    }
    void this.task.then(stop)
  }

  deferReap(reap: () => boolean): boolean {
    if (!this.pending) {
      return false
    }
    if (!this.reapQueued) {
      this.reapQueued = true
      void this.task?.then(reap)
    }
    return true
  }
}

type FaultOwnershipDeps = {
  readTable?: ProcessTableReader
  readProcessRow?: (pid: number) => Promise<ProcessRowRead>
  sendSignal?: SignalSender
}

/** Capture while P still owns its children; fd6 EOF alone does not reserve its PID. */
export async function terminateProviderFaultDescendants(
  identity: ProviderGroupIdentity,
  deps: FaultOwnershipDeps = {}
): Promise<DescendantTreeVerdict> {
  const expected = identity.leader
  const readRow = deps.readProcessRow ?? readPosixProcessRow
  const readTable = deps.readTable ?? readProcessTable
  let rootRetired = false
  let readSequence = 0
  let ownedPids: ReadonlySet<number> = new Set()
  const matchesRoot = (row: ProcessRowRead, capturedAtMs: number): boolean =>
    row !== null &&
    row !== 'unverifiable' &&
    sameProviderProcess(expected, row) &&
    (expected.startResolution !== 'second' ||
      hasUnambiguousStartTime(expected.startedAt, capturedAtMs))
  const ownedTable: ProcessTableReader = async (timeoutMs) => {
    const sequence = ++readSequence
    const deadline = performance.now() + (timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS)
    const before = rootRetired ? null : await readRow(expected.pid)
    const remaining = deadline - performance.now()
    if (remaining <= 0) {
      throw new Error('Provider ownership read timed out')
    }
    const capture = await readTable(remaining)
    const roots = capture.rows.filter((row) => row.pid === expected.pid)
    const root = roots.length === 1 ? roots[0] : undefined
    const after = rootRetired || performance.now() >= deadline ? null : await readRow(expected.pid)
    const expectedStart =
      expected.startResolution === 'microsecond'
        ? Number(expected.startedAt.split(':')[1]) * 1_000
        : Date.parse(expected.startedAt)
    const matchesTable =
      root?.pgid === identity.pgid &&
      Number.isFinite(Date.parse(root.startedAt)) &&
      (expected.startResolution === 'clock-tick' ||
        Math.floor(Date.parse(root.startedAt) / 1_000) === Math.floor(expectedStart / 1_000))
    if (
      !matchesRoot(before, capture.capturedAtMs) ||
      !matchesRoot(after, capture.capturedAtMs) ||
      !matchesTable
    ) {
      rootRetired = true
      // Retained descendants remain usable; a recycled root can never re-authorize ancestry.
      return { ...capture, rows: capture.rows.filter((row) => row.pid !== expected.pid) }
    }
    if (sequence === readSequence) {
      ownedPids =
        collectDescendantRows(expected.pid, capture.rows, capture.capturedAtMs).reDerivedPids ??
        new Set()
    }
    return capture
  }
  ownedTable.deadlineAllowanceMs = readTable.deadlineAllowanceMs
  const snapshot = await captureDescendantSnapshot(expected.pid, { readTable: ownedTable })
  if (!snapshot?.root || rootRetired) {
    return 'unverifiable'
  }
  // W must survive to finish the independent group stop, including after H disappears.
  snapshot.descendants = snapshot.descendants.filter((row) => row.pid !== identity.watcher.pid)
  if (snapshot.descendants.length === 0) {
    return 'exited'
  }
  const targets = new Map(snapshot.descendants.map((row) => [row.pid, row]))
  const sendSignal = deps.sendSignal ?? sendDescendantSignal
  const needsAncestry = snapshot.descendants.some(
    (row) => !hasUnambiguousStartIdentity(row, snapshot.capturedAtMs)
  )
  // Fault parity: finish owned tools before EOF/TERM can remove the last ancestry anchor.
  return terminateDescendantSnapshotWithVerdict(snapshot, {
    readTable: needsAncestry ? ownedTable : readTable,
    sendSignal: (pid, signal) => {
      const row = targets.get(pid)
      if (
        row &&
        (hasUnambiguousStartIdentity(row, snapshot.capturedAtMs) ||
          (!rootRetired && ownedPids.has(pid)))
      ) {
        sendSignal(pid, signal)
      }
    },
    requireIdentityBeforeSignal: true,
    graceMs: 0,
    keepAlive: true
  })
}
