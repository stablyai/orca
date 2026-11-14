/** Own destructive preparation through its handoff to a journaled job, before host resources close. */
class WorktreeRemovalLifetime {
  private readonly cleanup = new AbortController()
  get signal(): AbortSignal {
    return this.cleanup.signal
  }
  abortCleanup(): void {
    this.cleanup.abort()
  }
  private ready: Promise<void> = Promise.resolve()
  private readonly preparations = new Set<Promise<void>>()
  private stop = (): void => {}
  private drain = async (): Promise<void> => {}
  private completion?: Promise<void>
  closing = false

  prepare(load: () => Promise<void>, stop: () => void, drain: () => Promise<void>): Promise<void> {
    if (this.closing) {
      throw new Error('Orca is stopping. Reconnect or restart Orca, then retry deletion.')
    }
    this.stop = stop
    this.drain = drain
    this.ready = load().then(() => {
      if (this.closing) {
        throw new Error('Orca stopped while preparing workspace deletion. Restart Orca and retry.')
      }
    })
    return this.ready
  }

  acquirePreparation(): () => void {
    if (this.closing) {
      throw new Error('Orca is stopping. Reconnect or restart Orca, then retry deletion.')
    }
    let release!: () => void
    const preparation = new Promise<void>((resolve) => {
      release = resolve
    })
    this.preparations.add(preparation)
    return () => {
      this.preparations.delete(preparation)
      release()
    }
  }

  async withPreparation<T>(prepare: () => Promise<T>): Promise<T> {
    const release = this.acquirePreparation()
    try {
      return await prepare()
    } finally {
      release()
    }
  }

  resume(resume: () => void): void {
    if (!this.closing) {
      resume()
    }
  }

  close(): Promise<void> {
    if (!this.completion) {
      this.closing = true
      this.abortCleanup()
      this.stop()
      this.completion = (async () => {
        const loaded = await Promise.allSettled([this.ready])
        await Promise.all(this.preparations)
        await this.drain()
        if (loaded[0].status === 'rejected') {
          throw loaded[0].reason
        }
      })()
    }
    return this.completion
  }
}

export let worktreeRemovalLifetime = new WorktreeRemovalLifetime()

export function _resetWorktreeRemovalLifetimeForTests(): void {
  worktreeRemovalLifetime = new WorktreeRemovalLifetime()
}
