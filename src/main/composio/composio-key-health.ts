// What Composio last said about the key, for every client: refused, or limited for now or for the
// month. Clients hear only a change, and while a limit holds no automatic call goes out, so a
// re-read on the change can't feed another request. Each call takes a ticket when it starts, and
// only a call started after the refusal or limit was noted can lift it.
import type { ComposioLimit } from '../../shared/composio/composio-apps'
import { ComposioKeyRejectedError, ComposioLimitError } from './composio-api-errors'

export class ComposioKeyHealth {
  rejected = false
  private held: ComposioLimitError | null = null
  private tickets = 0
  /** The ticket current when the refusal or limit was noted. */
  private notedAt = 0

  constructor(
    private readonly onChange: () => void,
    private readonly now: () => number = Date.now
  ) {}

  /** The limit while it still holds: a burst until its time, the plan's cap until a deliberate check. */
  holding(): ComposioLimitError | null {
    const retryAt = this.held?.retryAt
    return retryAt === null || (retryAt !== undefined && this.now() < retryAt) ? this.held : null
  }

  get limit(): ComposioLimit | null {
    return this.holding() ? { retryAt: this.held?.retryAt ?? null } : null
  }

  /** Taken as a call starts. */
  ticket(): number {
    this.tickets += 1
    return this.tickets
  }

  /** A call that started with `ticket` succeeded; one older than what was noted says nothing. */
  answered(ticket: number): void {
    if ((this.rejected || this.held) && ticket > this.notedAt) {
      this.reset()
      this.onChange()
    }
  }

  failed(error: unknown): void {
    if (error instanceof ComposioKeyRejectedError && !this.rejected) {
      this.rejected = true
      this.notedAt = this.ticket()
      this.onChange()
    } else if (error instanceof ComposioLimitError) {
      const changed = !this.holding() || (this.held?.retryAt === null) !== (error.retryAt === null)
      this.held = error
      this.notedAt = this.ticket()
      if (changed) {
        this.onChange()
      }
    }
  }

  reset(): void {
    this.rejected = false
    this.held = null
  }
}
