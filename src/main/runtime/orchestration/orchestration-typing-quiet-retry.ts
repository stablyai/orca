import { remainingOrchestrationTypingQuietMs } from './orchestration-typing-quiet'

/** Coalesces one retry timer per mailbox so already-idle mail is not stranded (#14832). */
export class OrchestrationTypingQuietRetry {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

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
    const existing = this.timers.get(mailboxHandle)
    if (existing != null) {
      clearTimeout(existing)
    }
    const timer = setTimeout(() => {
      this.timers.delete(mailboxHandle)
      try {
        this.redrive(mailboxHandle, reservedTypes)
      } catch {
        // Durable mail remains available to explicit check or a later idle edge.
      }
    }, remaining)
    this.timers.set(mailboxHandle, timer)
    return true
  }
}
