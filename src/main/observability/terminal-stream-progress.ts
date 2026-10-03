import { isTracingEnabled, startSpan } from './tracer'

export type TerminalProgressCounter =
  | 'inputReceived'
  | 'inputBytes'
  | 'inputDelivered'
  | 'inputRejected'
  | 'inputFailed'
  | 'inputClaimRefused'
  | 'inputMobileLocked'
  | 'ackReceived'
  | 'ackRejected'
  | 'ipcInputAccepted'
  | 'ipcInputRefused'
  | 'ipcAckAccepted'
  | 'ipcAckRefused'

export type TerminalProgressReason =
  | 'credit_blocked'
  | 'output_progressed'
  | 'input_refused'
  | 'ack_rejected'
  | 'ipc_subscription_missing'
  | 'ipc_owner_mismatch'
  | 'ipc_transport_refused'

export type TerminalProgressIdentity = {
  side: 'client' | 'host'
  requestId?: string
  connectionId?: string
  subscriptionId?: string
  environmentId?: string
  terminal?: string
  streamGeneration?: string
  streamId: number
}

type ProgressSnapshot = Record<string, number | boolean | null>
type ProgressRecord = {
  identity: TerminalProgressIdentity
  counters: Partial<Record<TerminalProgressCounter, number>>
  snapshot: ProgressSnapshot
  reasons: TerminalProgressReason[]
  endedReasons: TerminalProgressReason[]
  observedForMs: number
  omittedReports: number
}
type PendingProgress = {
  firstObservedAt: number
  dueAt: number
  endedAt?: number
}

export const TERMINAL_PROGRESS_MAX_PENDING = 32
export const TERMINAL_PROGRESS_REPORT_INTERVAL_MS = 10_000
export const TERMINAL_CREDIT_STALL_MS = 5_000
const MAX_RETAINED_EPISODES = 2

export class TerminalStreamProgressReporter {
  private readonly pending = new Map<TerminalStreamProgress, Map<TerminalProgressReason, PendingProgress[]>>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextReportAt = 0
  private omittedReports = 0

  constructor(
    private readonly emit: (record: ProgressRecord) => void,
    private readonly enabled: () => boolean = () => true
  ) {}

  schedule(progress: TerminalStreamProgress, reason: TerminalProgressReason, delayMs: number): void {
    if (!this.enabled()) {
      return
    }
    const pending = this.pending.get(progress)
    const observations = pending?.get(reason) ?? []
    if (observations.some((entry) => entry.endedAt === undefined)) {
      return
    }
    if (!pending && this.pending.size >= TERMINAL_PROGRESS_MAX_PENDING) {
      this.omittedReports += 1
      return
    }
    const now = Date.now()
    const reasons = pending ?? new Map<TerminalProgressReason, PendingProgress[]>()
    if (observations.length === MAX_RETAINED_EPISODES) {
      observations.shift()
      this.omittedReports += 1
    }
    observations.push({
      firstObservedAt: now,
      dueAt: now + delayMs
    })
    reasons.set(reason, observations)
    this.pending.set(progress, reasons)
    this.arm()
  }

  clear(progress: TerminalStreamProgress, reason?: TerminalProgressReason, preserveDue = false): void {
    const pending = this.pending.get(progress)
    if (!pending) {
      return
    }
    if (reason) {
      const observations = pending.get(reason)
      if (!observations) {
        return
      }
      if (preserveDue && observations.every((entry) => entry.endedAt !== undefined)) {
        return
      }
      const now = Date.now()
      const retained = preserveDue ? observations.filter((entry) => entry.dueAt <= now) : []
      if (retained.length > 0) {
        for (const entry of retained) {
          entry.endedAt ??= now
        }
        pending.set(reason, retained)
      } else {
        pending.delete(reason)
      }
    }
    if (!reason || pending.size === 0) {
      this.pending.delete(progress)
    }
    this.arm()
  }

  private arm(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending.size === 0) {
      return
    }
    let dueAt = Number.POSITIVE_INFINITY
    for (const reasons of this.pending.values()) {
      for (const observations of reasons.values()) {
        for (const entry of observations) {
          dueAt = Math.min(dueAt, entry.dueAt)
        }
      }
    }
    this.timer = setTimeout(() => this.flush(), Math.max(0, Math.max(dueAt, this.nextReportAt) - Date.now()))
    this.timer.unref?.()
  }

  private flush(): void {
    this.timer = null
    if (!this.enabled()) {
      this.pending.clear()
      return
    }
    const now = Date.now()
    for (const [progress, pending] of this.pending) {
      const reasons = [...pending].flatMap(([reason, observations]) =>
        observations.filter((entry) => entry.dueAt <= now).map((entry) => [reason, entry] as const)
      )
      if (reasons.length === 0) {
        continue
      }
      for (const [reason, observations] of pending) {
        const retained = observations.filter((entry) => entry.dueAt > now)
        if (retained.length > 0) {
          pending.set(reason, retained)
        } else {
          pending.delete(reason)
        }
      }
      if (pending.size === 0) {
        this.pending.delete(progress)
      }
      const omittedReports = this.omittedReports
      this.omittedReports = 0
      this.nextReportAt = now + TERMINAL_PROGRESS_REPORT_INTERVAL_MS
      const emittedReasons = [...new Set(reasons.map(([reason]) => reason))]
      try {
        this.emit({
          identity: progress.identity,
          counters: { ...progress.counters },
          snapshot: progress.snapshot(),
          reasons: emittedReasons,
          endedReasons: emittedReasons.filter((reason) =>
            reasons.every(([candidate, entry]) => candidate !== reason || entry.endedAt !== undefined)
          ),
          observedForMs: Math.max(...reasons.map(([, entry]) => (entry.endedAt ?? now) - entry.firstObservedAt)),
          omittedReports
        })
        progress.reported(new Set(reasons.filter(([, entry]) => entry.endedAt === undefined).map(([reason]) => reason)))
      } catch {
        this.omittedReports += omittedReports + 1
      }
      break
    }
    this.arm()
  }
}

export class TerminalStreamProgress {
  readonly counters: Partial<Record<TerminalProgressCounter, number>> = {}
  private creditWasReported = false
  private disposed = false

  constructor(
    private readonly reporter: TerminalStreamProgressReporter,
    readonly identity: TerminalProgressIdentity,
    readonly snapshot: () => ProgressSnapshot = () => ({})
  ) {}

  count(counter: TerminalProgressCounter, amount = 1): void {
    this.counters[counter] = (this.counters[counter] ?? 0) + amount
  }

  report(reason: TerminalProgressReason, delayMs = 1_000): void {
    if (!this.disposed) {
      this.reporter.schedule(this, reason, delayMs)
    }
  }

  creditBlocked(): void {
    this.report('credit_blocked', TERMINAL_CREDIT_STALL_MS)
  }

  creditRestored(): void {
    this.reporter.clear(this, 'credit_blocked', true)
    if (this.creditWasReported) {
      this.creditWasReported = false
      this.report('output_progressed')
    }
  }

  creditCancelled(): void {
    this.reporter.clear(this, 'credit_blocked')
    this.creditWasReported = false
  }

  reported(reasons: ReadonlySet<TerminalProgressReason>): void {
    if (reasons.has('credit_blocked')) {
      this.creditWasReported = true
    }
  }

  dispose(): void {
    this.disposed = true
    this.reporter.clear(this)
  }
}

function opaqueIdentity(identity: TerminalProgressIdentity): Record<string, string | number> {
  const result: Record<string, string | number> = { side: identity.side, streamId: identity.streamId }
  for (const [key, value] of Object.entries(identity)) {
    if (typeof value === 'string' && /^[\w:-]{1,128}$/u.test(value)) {
      result[key] = value
    }
  }
  return result
}

export const terminalStreamProgressReporter = new TerminalStreamProgressReporter(
  (record) => {
    startSpan('terminal.stream.progress', {
      attributes: {
        ...opaqueIdentity(record.identity),
        counters: record.counters,
        state: record.snapshot,
        reasons: record.reasons,
        endedReasons: record.endedReasons,
        observedForMs: record.observedForMs,
        omittedReports: record.omittedReports
      }
    }).end()
  },
  isTracingEnabled
)
