export type OrcadRuntimeCleanup = (state: { failed: boolean }) => void | Promise<void>

/**
 * Stops runtime resources in reverse acquisition order, then releases profile ownership.
 *
 * Every cleanup runs even after an earlier one fails, but a failed teardown never releases:
 * a writer that may still be running cannot hand the data root to a second orcad.
 */
export class OrcadRuntimeLifetime {
  private readonly cleanups: OrcadRuntimeCleanup[] = []
  private stopping?: Promise<void>

  constructor(private readonly release: () => void = () => {}) {}

  add(cleanup: OrcadRuntimeCleanup): void {
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
          await cleanup({ failed: errors.length > 0 })
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length === 1) {
        throw errors[0]
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, 'orcad_runtime_cleanup_failed')
      }
      this.release()
    })
    return this.stopping
  }
}
