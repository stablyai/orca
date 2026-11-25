// One follow of a computer's shares at a time (two would each ask its host for a key); one asked for
// meanwhile runs once after it, with the newest client, so a share listed mid-follow is still read.
type Follow<C> = { again: C | null; done: Promise<void> }

export class PhoneSharedAgentFollows<C> {
  private readonly running = new Map<string, Follow<C>>()

  constructor(private readonly follow: (pairedHostId: string, client: C) => Promise<void>) {}

  /** The follow of `pairedHostId` under way, with any asked for meanwhile; none: resolved. */
  current(pairedHostId: string): Promise<void> {
    return this.running.get(pairedHostId)?.done ?? Promise.resolve()
  }

  async run(pairedHostId: string, client: C): Promise<void> {
    const running = this.running.get(pairedHostId)
    if (running) {
      running.again = client
      return await running.done
    }
    const follow: Follow<C> = { again: client, done: Promise.resolve() }
    this.running.set(pairedHostId, follow)
    follow.done = (async () => {
      try {
        while (follow.again) {
          const next = follow.again
          follow.again = null
          await this.follow(pairedHostId, next)
        }
      } finally {
        this.running.delete(pairedHostId)
      }
    })()
    return await follow.done
  }
}
