import { NextReadWaits } from '../../../../src/shared/concurrency/next-read-waits'

// One follow of a computer's shares at a time (two would each ask its host for a key); one asked for
// meanwhile runs once after it, with the newest client, so a share listed mid-follow is still read.
type Follow<C> = { again: C | null; done: Promise<void> }
type FollowRun<C> = (pairedHostId: string, client: C, applied: () => void) => Promise<void>

// How long a call on a dropped link waits for its computer's list to say whether it was a revoke.
const LIST_WAIT_MS = 5000

export class PhoneSharedAgentFollows<C> {
  private readonly running = new Map<string, Follow<C>>()

  private readonly waits = new Map<string, NextReadWaits>()

  constructor(private readonly follow: FollowRun<C>) {}

  /** Once a follow of `pairedHostId` under way or asked for has its list applied, at most
   *  LIST_WAIT_MS (the computer may be away); at once when none is. */
  async nextListed(pairedHostId: string): Promise<void> {
    const waits = this.waits.get(pairedHostId)
    const again = this.running.get(pairedHostId)?.again != null
    if (waits && (waits.listing() || again)) {
      await waits.next(again)
    }
  }

  async run(pairedHostId: string, client: C): Promise<void> {
    const running = this.running.get(pairedHostId)
    if (running) {
      running.again = client
      return await running.done
    }
    const follow: Follow<C> = { again: client, done: Promise.resolve() }
    this.running.set(pairedHostId, follow)
    const waits = this.waits.get(pairedHostId) ?? new NextReadWaits(LIST_WAIT_MS)
    this.waits.set(pairedHostId, waits)
    follow.done = (async () => {
      try {
        while (follow.again) {
          const next = follow.again
          follow.again = null
          const applied = waits.reading()
          try {
            await this.follow(pairedHostId, next, applied)
          } finally {
            applied()
          }
        }
      } finally {
        this.running.delete(pairedHostId)
        waits.idle()
      }
    })()
    return await follow.done
  }
}
