import type { AgentIdentityClient } from './agent-identity-worker-client'

/** One explicit read-only question: `send` resolves true when the store could not answer. */
export type AgentIdentityLookup = {
  send: (client: AgentIdentityClient, path: string) => Promise<boolean>
  cancel: () => void
}

/** Questions for the identity store's one-at-a-time queue; each caller waits at most `waitMs`,
 *  and a question already sent may finish after its caller stopped waiting. */
export class AgentIdentityLookupQueue {
  /** Callers still waiting, in arrival order; a sent question stays until it is answered. */
  private readonly waiting = new Set<AgentIdentityLookup>()
  private readonly sent = new WeakSet<AgentIdentityLookup>()

  constructor(private readonly waitMs: number) {}

  enqueue<T>(
    run: (client: AgentIdentityClient, path: string) => Promise<T | undefined>
  ): Promise<T | undefined> {
    return new Promise((resolve) => {
      const done = (value: T | undefined): void => {
        clearTimeout(timer)
        this.waiting.delete(lookup)
        resolve(value)
      }
      const lookup: AgentIdentityLookup = {
        send: async (client, path) => {
          const value = await run(client, path)
          done(value)
          return value === undefined
        },
        cancel: () => done(undefined)
      }
      const timer = setTimeout(lookup.cancel, this.waitMs)
      timer.unref()
      this.waiting.add(lookup)
    })
  }

  /** The oldest question not yet sent, marked sent. */
  next(): AgentIdentityLookup | undefined {
    for (const lookup of this.waiting) {
      if (!this.sent.has(lookup)) {
        this.sent.add(lookup)
        return lookup
      }
    }
    return undefined
  }

  /** An ended store authority: every waiting caller gets no answer now. */
  cancelAll(): void {
    for (const lookup of this.waiting) {
      lookup.cancel()
    }
  }
}
