import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import { isSqliteStorageFailure } from '../../sqlite/sqlite-read-failure'

/**
 * Converted chats an older Orca may have continued, with no revision to compare, are compared one
 * per idle step on a reader. Each settles durably, so an interrupted run resumes next launch.
 */
export async function compareJournalLegacyChatsWhenIdle(
  writer: Pick<JournalSqlOwner, 'maintain'>,
  readers: Pick<JournalSqlReaderPool, 'database' | 'compareLegacyChat'>,
  boundary: () => Promise<boolean>,
  stopped: () => boolean,
  report: (error: unknown, sessionId: string) => void
): Promise<void> {
  let after: string | null = null
  while (await boundary()) {
    const page = await readers.database({ kind: 'legacy-compares', after })
    if (page.kind !== 'legacy-compares') {
      throw new Error('journal reader returned no legacy compares')
    }
    if (page.compares.length === 0) {
      return
    }
    for (const compare of page.compares) {
      if (!(await boundary())) {
        return
      }
      let result: Awaited<ReturnType<JournalSqlReaderPool['compareLegacyChat']>>
      try {
        result = await readers.compareLegacyChat(compare.sessionId)
      } catch (error) {
        report(error, compare.sessionId)
        // Stopping or contention leaves it for the next launch; a chat whose compare took its
        // reader down is absorbed with its error, never retried into the same crash.
        if (stopped() || isSqliteStorageFailure(error)) {
          continue
        }
        result = { error: error instanceof Error ? error.message : String(error) }
      }
      if (result && ('error' in result || result.revision === compare.revision)) {
        await writer.maintain({ kind: 'legacy-compare-settle', ...compare, ...result })
      }
    }
    after = page.compares.at(-1)!.sessionId
  }
}
