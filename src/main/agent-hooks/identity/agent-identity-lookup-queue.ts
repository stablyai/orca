import type { AgentIdentityClient } from './agent-identity-worker-client'

/** One explicit read-only question, shared by every caller asking it: `send` resolves true when
 *  the store could not answer. */
export type AgentIdentityLookup = {
  send: (client: AgentIdentityClient, path: string) => Promise<boolean>
}

type PendingLookup = {
  lookup: AgentIdentityLookup
  waiters: Set<(value: unknown) => void>
  sent: boolean
}

/** Questions for the identity store's one-at-a-time queue, keyed so simultaneous callers of one
 *  question share one worker operation. Each caller waits at most `waitMs`; a question already
 *  sent may finish after its callers stopped waiting. Nothing is kept once answered. */
export class AgentIdentityLookupQueue {
  /** Questions with callers still waiting, in arrival order; a sent one stays until answered. */
  private readonly pending = new Map<string, PendingLookup>()

  constructor(private readonly waitMs: number) {}

  /** `key` names the question: one key always runs the same `run`, so it answers with `T`. */
  enqueue<T>(
    key: string,
    run: (client: AgentIdentityClient, path: string) => Promise<T | undefined>
  ): Promise<T | undefined> {
    let entry = this.pending.get(key)
    if (!entry) {
      const created: PendingLookup = {
        waiters: new Set(),
        sent: false,
        lookup: {
          send: async (client, path) => {
            const value = await run(client, path)
            this.answer(key, created, value)
            return value === undefined
          }
        }
      }
      entry = created
      this.pending.set(key, entry)
    }
    const shared = entry
    return new Promise((resolve) => {
      const waiter = (value: unknown): void => {
        clearTimeout(timer)
        shared.waiters.delete(waiter)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a key always names the same question, so its answer is this caller's `T`.
        resolve(value as T | undefined)
      }
      const timer = setTimeout(() => {
        waiter(undefined)
        // An unsent question nobody waits for is never sent.
        if (!shared.sent && shared.waiters.size === 0 && this.pending.get(key) === shared) {
          this.pending.delete(key)
        }
      }, this.waitMs)
      timer.unref()
      shared.waiters.add(waiter)
    })
  }

  /** The oldest question not yet sent, marked sent. */
  next(): AgentIdentityLookup | undefined {
    for (const entry of this.pending.values()) {
      if (!entry.sent) {
        entry.sent = true
        return entry.lookup
      }
    }
    return undefined
  }

  /** An ended store authority: every waiting caller gets no answer now. */
  cancelAll(): void {
    for (const [key, entry] of this.pending) {
      this.answer(key, entry, undefined)
    }
  }

  private answer(key: string, entry: PendingLookup, value: unknown): void {
    if (this.pending.get(key) === entry) {
      this.pending.delete(key)
    }
    for (const waiter of entry.waiters) {
      waiter(value)
    }
  }
}
