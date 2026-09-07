// Where a journal goes when its close REJECTS.
//
// `AgentSessionJournal.close()` is deliberately retryable: a rejection does not
// release the handle, and a second call is a real second attempt. Every caller
// that did `close().catch(() => undefined)` and then threw or overwrote its map
// entry defeated that contract — the store became unreachable with its SQLite
// connection still open. On POSIX that is a silent leak; on Windows the open
// handle blocks renaming or removing the journal directory outright.
//
// So a rejected close hands the journal here instead of dropping it, and host
// teardown retries everything this holds. Retention is bounded by construction:
// an entry leaves the set the moment its close fulfils, and a journal can be
// retained only once because the set is keyed by identity.

/** Everything the registry needs; `AgentSessionJournal` satisfies it. */
export type RetryableJournalClose = {
  close: () => Promise<void>
  readonly directory: string
}

export class JournalCloseRetryRegistry {
  private readonly retained = new Set<RetryableJournalClose>()

  /** Directories still held by a journal whose close has not fulfilled. */
  get pendingDirectories(): string[] {
    return [...this.retained].map((journal) => journal.directory)
  }

  /**
   * Close it. Returns true when the handle is actually released; on a rejection
   * the journal is RETAINED for `retryAll` and the rejection is returned rather
   * than thrown, because every caller of this is already unwinding a different
   * failure it must not lose.
   */
  async closeOrRetain(
    journal: RetryableJournalClose
  ): Promise<{ closed: boolean; error?: unknown }> {
    try {
      await journal.close()
      this.retained.delete(journal)
      return { closed: true }
    } catch (error) {
      this.retained.add(journal)
      return { closed: false, error }
    }
  }

  /** Retry every retained close. Ones that fulfil are dropped; ones that reject
   *  stay retained and their rejections are returned for the caller to report. */
  async retryAll(): Promise<unknown[]> {
    const entries = [...this.retained]
    const failures: unknown[] = []
    for (const journal of entries) {
      const result = await this.closeOrRetain(journal)
      if (!result.closed) {
        failures.push(result.error)
      }
    }
    return failures
  }
}

/**
 * Process-wide, because ownership of these handles is process-wide: the attach
 * path, the recovery wrapper and runtime teardown are separate call trees that
 * must all be able to reach the same orphan.
 */
export const agentSessionJournalCloseRetries = new JournalCloseRetryRegistry()
