import { remainingOrchestrationTypingQuietMs } from './orchestration-typing-quiet'

/** Coalesces one retry timer per mailbox so already-idle mail is not stranded (#14832). */
export class OrchestrationTypingQuietRetry {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly reservedTypesByMailbox = new Map<string, Set<string> | null>()

  constructor(
    private readonly redrive: (mailboxHandle: string, reservedTypes?: ReadonlySet<string>) => void
  ) {}

  /** True when delivery must wait for the remaining quiet window. */
  defer(
    snapshot: {
      lastUserInputAt: number | undefined
      now: number
      windowFocused: boolean
    },
    mailboxHandle: string,
    reservedTypes?: ReadonlySet<string>
  ): boolean {
    const remaining = remainingOrchestrationTypingQuietMs(snapshot)
    if (remaining <= 0) {
      return false
    }
    this.mergeReservedTypes(mailboxHandle, reservedTypes)
    const existing = this.timers.get(mailboxHandle)
    if (existing != null) {
      clearTimeout(existing)
    }
    const timer = setTimeout(() => {
      this.timers.delete(mailboxHandle)
      const reserved = this.reservedTypesByMailbox.get(mailboxHandle)
      this.reservedTypesByMailbox.delete(mailboxHandle)
      try {
        this.redrive(mailboxHandle, reserved ?? undefined)
      } catch {
        // Durable mail remains available to explicit check or a later idle edge.
      }
    }, remaining)
    this.timers.set(mailboxHandle, timer)
    return true
  }

  // Why: match parkRedelivery so a later defer cannot drop an earlier reserved type.
  private mergeReservedTypes(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): void {
    const prior = this.reservedTypesByMailbox.get(mailboxHandle)
    const hasPrior = this.reservedTypesByMailbox.has(mailboxHandle)
    const current = reservedTypes && reservedTypes.size > 0 ? reservedTypes : undefined
    if (!hasPrior) {
      this.reservedTypesByMailbox.set(mailboxHandle, current ? new Set(current) : null)
      return
    }
    if (prior == null || current === undefined) {
      this.reservedTypesByMailbox.set(mailboxHandle, null)
      return
    }
    this.reservedTypesByMailbox.set(mailboxHandle, new Set([...prior, ...current]))
  }
}
