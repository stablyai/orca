import type { UsageLimitAccountReading } from '../../../rate-limits/usage-limit-account-reading'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'

/** Providers roll a window over a little after its stated reset. */
export const USAGE_LIMIT_RESET_GRACE_MS = 15_000
/** Back-to-back automatic continues that hit the limit again at once before Orca leaves the chat to the person. */
export const USAGE_LIMIT_MAX_QUICK_REFAILS = 3
/** A continuation that ends in a usage limit this soon never got to work. */
const QUICK_REFAIL_MS = 2 * 60_000
const REFAIL_BACKOFF_MS = 5 * 60_000

export type UsageLimitAccountHold =
  | { kind: 'none' }
  /** The account's own usage says the limit lasts until then. */
  | { kind: 'wait'; until: number }
  /** The last reading predates the reset or the cut, so it cannot vouch for room yet. */
  | { kind: 'refresh' }

/** Holds a due cut until a usage reading taken after its reset shows room again. */
export function usageLimitAccountHold(
  cut: { resetsAt: number; turnEndedAt: number },
  reading: UsageLimitAccountReading | null,
  now: number
): UsageLimitAccountHold {
  if (!reading) {
    return { kind: 'none' }
  }
  if (reading.exhausted && reading.resetsAt !== null) {
    if (now < reading.resetsAt + USAGE_LIMIT_RESET_GRACE_MS) {
      return { kind: 'wait', until: reading.resetsAt }
    }
    return { kind: 'refresh' }
  }
  if (reading.exhausted || reading.checkedAt < Math.max(cut.resetsAt, cut.turnEndedAt)) {
    return { kind: 'refresh' }
  }
  return { kind: 'none' }
}

/** Reads each provider's usage once per sweep and asks for a fresh reading at most once a minute. */
export class UsageLimitAccountGate {
  private readonly readings = new Map<string, UsageLimitAccountReading | null>()
  private refreshedAt = -Infinity

  constructor(
    private readonly source: () => StructuredAgentSessionHostDeps['usageLimitAutoContinue'],
    private readonly now: () => number
  ) {}

  beginPass(): void {
    this.readings.clear()
  }

  /** Only a sweep about to send may ask for a refresh; status reads before the reset must not. */
  hold(
    provider: string | undefined,
    cut: { resetsAt: number; turnEndedAt: number },
    mayRefresh: boolean
  ): UsageLimitAccountHold {
    if (provider === undefined) {
      return { kind: 'none' }
    }
    const reading = this.readings.has(provider)
      ? (this.readings.get(provider) ?? null)
      : (this.source()?.readAccountUsage?.(provider) ?? null)
    this.readings.set(provider, reading)
    const now = this.now()
    const hold = usageLimitAccountHold(cut, reading, now)
    if (mayRefresh && hold.kind === 'refresh' && now - this.refreshedAt >= 60_000) {
      this.refreshedAt = now
      this.source()?.refreshAccountUsage?.()
    }
    return hold
  }
}

/** Counts automatic continues that ended in a usage limit again right away, per chat. */
export class UsageLimitQuickRefails {
  private readonly sent = new Map<string, { sends: number; sentAt: number }>()

  /** Quick refailures behind the chat's current cut; zero once a continuation really ran. */
  count(id: string, cut: { turnEndedAt: number }): number {
    const last = this.sent.get(id)
    if (!last) {
      return 0
    }
    if (cut.turnEndedAt < last.sentAt) {
      return last.sends - 1
    }
    if (cut.turnEndedAt - last.sentAt < QUICK_REFAIL_MS) {
      return last.sends
    }
    this.sent.delete(id)
    return 0
  }

  /** Earliest time the chat may be continued again after quick refailures. */
  notBefore(id: string, cut: { turnEndedAt: number }): number {
    const refails = this.count(id, cut)
    const last = this.sent.get(id)
    return refails > 0 && last ? last.sentAt + REFAIL_BACKOFF_MS * 2 ** (refails - 1) : 0
  }

  continued(id: string, cut: { turnEndedAt: number }, at: number): void {
    this.sent.set(id, { sends: this.count(id, cut) + 1, sentAt: at })
  }

  retain(shown: ReadonlySet<string>): void {
    for (const id of this.sent.keys()) {
      if (!shown.has(id)) {
        this.sent.delete(id)
      }
    }
  }

  clear(): void {
    this.sent.clear()
  }
}
