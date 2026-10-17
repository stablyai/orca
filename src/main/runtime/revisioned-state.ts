// A value read by revision: a reader names the revision it shows and waits, bounded, for a newer
// one. Its owner keeps its own lifecycle policy; this only publishes and waits.

import { delayUnlessAborted } from '../../shared/abort-aware-delay'

export class RevisionedState<S> {
  private revision = 0
  private readonly changed = new Set<() => void>()

  constructor(private value: S) {}

  get(): { value: S; revision: number } {
    return { value: this.value, revision: this.revision }
  }

  set(value: S): void {
    this.value = value
    this.revision += 1
    this.changed.forEach((notify) => notify())
  }

  /** Resolves once the revision differs from `shown`, after `waitMs`, or when `signal` aborts. */
  async waitForChange(shown: number | undefined, waitMs: number, signal?: AbortSignal) {
    if (shown !== this.revision) {
      return
    }
    const changed = new AbortController()
    const notify = (): void => changed.abort()
    this.changed.add(notify)
    try {
      await delayUnlessAborted(
        waitMs,
        AbortSignal.any([changed.signal, ...(signal ? [signal] : [])])
      )
    } finally {
      this.changed.delete(notify)
    }
  }
}
