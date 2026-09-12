/** Keeps profile ownership until all registered runtime resources have stopped. */
export class OrcadRuntimeLifetime {
  private readonly cleanups: (() => void | Promise<void>)[] = []
  private stopping?: Promise<void>

  constructor(private readonly releaseLock: () => void) {}

  add(cleanup: () => void | Promise<void>): void {
    if (this.stopping) {
      throw new Error('orcad_runtime_lifetime_stopping')
    }
    this.cleanups.push(cleanup)
  }

  stop(): Promise<void> {
    this.stopping ??= Promise.resolve().then(async () => {
      const errors: unknown[] = []
      for (const cleanup of this.cleanups.splice(0).toReversed()) {
        try {
          await cleanup()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) {
        // Failed teardown cannot authorize a second writer while this process still exists.
        throw new AggregateError(errors, 'orcad_runtime_cleanup_failed')
      }
      this.releaseLock()
    })
    return this.stopping
  }
}
