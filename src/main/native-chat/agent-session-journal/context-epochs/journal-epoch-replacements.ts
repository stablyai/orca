/** One listener, told in the tick each epoch replacement reaches the writer. */
export class JournalEpochReplacements {
  private listener: ((replaced: Promise<unknown>) => void) | null = null

  notify = (replaced: Promise<unknown>): void => this.listener?.(replaced)

  /** Writer commands that replace the epoch announce themselves; others pass through. */
  notifyFor = <T extends { dropped?: true }>(
    operation: { kind: string; guard?: unknown },
    written: Promise<T>
  ): Promise<T> => {
    const { kind } = operation
    if (kind === 'epoch-replace' && operation.guard) {
      void written.then(
        (commit) => {
          if (!commit.dropped) {
            this.notify(written)
          }
        },
        () => undefined
      )
    } else if (kind === 'epoch-replace' || kind === 'context-rewind' || kind === 'rewind-cut') {
      this.notify(written)
    }
    return written
  }

  observe = (listener: (replaced: Promise<unknown>) => void): (() => void) => {
    const registered: typeof listener = (replaced) => listener(replaced)
    this.listener = registered
    return () => {
      if (this.listener === registered) {
        this.listener = null
      }
    }
  }
}
