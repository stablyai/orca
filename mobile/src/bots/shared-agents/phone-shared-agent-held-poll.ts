// Orca Cloud's states for the shared agents with a message waiting: read now, and again while one
// still waits, so a delivered message lets that chat's later sends go live again.
import type { PhoneSharedAgentHeld } from './phone-shared-agent-held'
import type { PhoneSharedAgent, PhoneSharedAgentStore } from './phone-shared-agent-store'

// While a message waits, Orca Cloud is asked how it stands this often (the desktop's busy read),
// backing off to at most HELD_POLL_MAX_MS while it doesn't answer.
const HELD_POLL_MS = 30_000
const HELD_POLL_MAX_MS = 5 * 60_000

export class PhoneSharedAgentHeldPoll {
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0

  constructor(
    private readonly deps: { store: PhoneSharedAgentStore; held: () => PhoneSharedAgentHeld }
  ) {}

  async refresh(entries: readonly PhoneSharedAgent[] = this.deps.store.list()): Promise<void> {
    const held = this.deps.held()
    const answered = await Promise.all(
      entries
        .filter((entry) => entry.held.some((message) => held.isWaiting(message)))
        .map((entry) => held.refresh(entry))
    )
    this.failures = answered.includes(false) ? this.failures + 1 : 0
    this.poll()
  }

  /** Reads again in HELD_POLL_MS (backed off) while a message waits; stops once none does. */
  poll(): void {
    const held = this.deps.held()
    const waiting = this.deps.store
      .list()
      .some((entry) => entry.held.some((message) => held.isWaiting(message)))
    if (!waiting) {
      clearTimeout(this.timer ?? undefined)
      this.timer = null
      return
    }
    if (this.timer) {
      return
    }
    const delay = Math.min(HELD_POLL_MS * 2 ** this.failures, HELD_POLL_MAX_MS)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, delay)
  }
}
