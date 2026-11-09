import { federationRelayRetryDelayMs } from './federation-relay-scheduler'

type PendingAcknowledgmentRow = { dispatchId: string; rowId: number }

type RetryDeadline = { failures: number; dueAt: number }

/** Walks pending rows from the cursor once around, skipping rows still cooling after a failure. */
function nextDueAcknowledgment(
  findNextAfter: (afterRowId: number) => PendingAcknowledgmentRow | undefined,
  cursorRowId: number,
  deadlines: Map<string, RetryDeadline>,
  now: number
): PendingAcknowledgmentRow | { waitMs: number } | null {
  const pending = new Set<string>()
  let afterRowId = cursorRowId
  let wrapped = afterRowId === 0
  for (;;) {
    const row = findNextAfter(afterRowId)
    if (!row) {
      if (wrapped) {
        break
      }
      wrapped = true
      afterRowId = 0
      continue
    }
    if (pending.has(row.dispatchId)) {
      break
    }
    pending.add(row.dispatchId)
    if ((deadlines.get(row.dispatchId)?.dueAt ?? 0) <= now) {
      return row
    }
    afterRowId = row.rowId
  }
  let earliest = Infinity
  for (const [dispatchId, { dueAt }] of deadlines) {
    if (pending.has(dispatchId)) {
      earliest = Math.min(earliest, dueAt)
    } else {
      deadlines.delete(dispatchId)
    }
  }
  return pending.size === 0 ? null : { waitMs: Math.max(0, earliest - now) }
}

/** Settles terminal dispatches' outstanding acknowledgments one row per tick; a failing row cools off without holding back the rest. */
export class FederationAcknowledgmentRecovery {
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private cursorRowId = 0
  private generation = 0
  private readonly deadlines = new Map<string, RetryDeadline>()

  constructor(
    private readonly deps: {
      findNextAfter: (afterRowId: number) => PendingAcknowledgmentRow | undefined
      sync: (dispatchId: string) => Promise<unknown>
      acknowledgedThrough: (dispatchId: string) => number | null
    }
  ) {}

  ensure(): void {
    if (this.timer || this.inFlight) {
      return
    }
    const recovery = this.recoverNext(this.generation).catch((error) => {
      console.warn('[orchestration] terminal federation acknowledgment recovery failed', error)
    })
    this.inFlight = recovery
    void recovery.finally(() => {
      if (this.inFlight === recovery) {
        this.inFlight = null
      }
    })
  }

  reset(): void {
    this.generation += 1
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
    this.inFlight = null
    this.cursorRowId = 0
    this.deadlines.clear()
  }

  private async recoverNext(generation: number): Promise<void> {
    const next = nextDueAcknowledgment(
      this.deps.findNextAfter,
      this.cursorRowId,
      this.deadlines,
      Date.now()
    )
    if (!next) {
      return
    }
    if ('waitMs' in next) {
      this.schedule(next.waitMs)
      return
    }
    this.cursorRowId = next.rowId
    const acknowledgedBefore = this.deps.acknowledgedThrough(next.dispatchId)
    const synced = await this.deps.sync(next.dispatchId).then(
      () => true,
      () => false
    )
    if (generation !== this.generation) {
      return
    }
    // Large backlogs settle a few pages per sync; only a sync that left the acknowledgment where it was made no progress.
    const progressed =
      synced &&
      (this.deps.findNextAfter(next.rowId - 1)?.dispatchId !== next.dispatchId ||
        this.deps.acknowledgedThrough(next.dispatchId) !== acknowledgedBefore)
    if (progressed) {
      this.deadlines.delete(next.dispatchId)
    } else {
      const failures = (this.deadlines.get(next.dispatchId)?.failures ?? 0) + 1
      this.deadlines.set(next.dispatchId, {
        failures,
        dueAt: Date.now() + federationRelayRetryDelayMs(failures)
      })
    }
    this.schedule(federationRelayRetryDelayMs(0))
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      this.ensure()
    }, delayMs)
    this.timer.unref?.()
  }
}
