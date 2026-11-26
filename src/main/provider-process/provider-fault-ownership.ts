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
import type { ProcessTableReader } from '../pty/process-retirement/pty-descendant-fresh-table'
import { sameProviderProcess, type ProviderGroupIdentity } from './provider-group-orphan-guard'
import {
  PROCESS_ROW_TIMEOUT_MS,
  readPosixProcessRow,
  type ProviderProcessRowReader,
  type ProcessRowRead
} from './provider-process-row-read'
import type { publishProviderOwnership } from './provider-ownership-journal'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import { PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS } from './provider-process-supervisor'

export class ProviderFaultOwnership {
  task?: Promise<DescendantTreeVerdict | undefined>
  private pending = false
  private normalOutcome?: Promise<boolean>
  private readonly deferred = new Map<'stdin' | 'term' | 'reap' | 'owner-loss', () => void>()

  stopAfterCapture(
    ownership: Promise<Awaited<ReturnType<typeof publishProviderOwnership>>> | undefined,
    stop: () => void,
    normalOutcome?: Promise<boolean>
  ): void {
    if (!this.task) {
      this.pending = true
      // Only completion-first capture can be superseded by a later valid outcome.
      this.normalOutcome = normalOutcome
      this.task = Promise.resolve(ownership)
        .then((registered) =>
          registered ? terminateProviderFaultDescendants(registered.identity) : undefined
        )
        .catch(() => 'unverifiable' as const)
        .finally(() => {
          this.pending = false
          const deferred = [...this.deferred.values()]
          this.deferred.clear()
          for (const action of deferred) {
            action()
          }
        })
    }
    this.stop('owner-loss', stop)
  }

  /** Only an attempted capture can fail; normal exit never claims detached tools. */
  async descendantsCleaned(): Promise<boolean> {
    const verdict = await this.task
    return (
      verdict === undefined ||
      verdict === 'exited' ||
      (this.normalOutcome !== undefined &&
        (await withTimeout(this.normalOutcome, PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS, false)))
    )
  }

  /** Coalesce destructive requests while the one bounded fault task owns the last anchor. */
  deferStop(kind: 'stdin' | 'term' | 'reap' | 'owner-loss', stop: () => void): boolean {
    if (!this.pending) {
      return false
    }
    this.deferred.set(kind, stop)
    return true
  }

  stop(kind: 'stdin' | 'owner-loss', stop: () => void): void {
    if (!this.deferStop(kind, stop)) {
      stop()
    }
  }
}

type FaultOwnershipDeps = {
  readTable?: ProcessTableReader
  readProcessRow?: ProviderProcessRowReader
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
    const before = rootRetired ? null : await readRow(expected.pid, expected.startResolution)
    if (before === 'unverifiable') {
      throw new Error('Provider ownership is unreadable')
    }
    if (sequence === 1 && !matchesRoot(before, Date.now())) {
      return { rows: [], capturedAtMs: Date.now() }
    }
    const capture = await readTable(timeoutMs)
    const roots = capture.rows.filter((row) => row.pid === expected.pid)
    const root = roots.length === 1 ? roots[0] : undefined
    const after = rootRetired ? null : await readRow(expected.pid, expected.startResolution)
    if (after === 'unverifiable') {
      throw new Error('Provider ownership is unreadable')
    }
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
  // The table keeps its own budget; the two bounded identity reads surround it.
  ownedTable.deadlineAllowanceMs = (timeoutMs) =>
    2 * PROCESS_ROW_TIMEOUT_MS + (readTable.deadlineAllowanceMs?.(timeoutMs) ?? 0)
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
