import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import { isSqliteCorruption, isSqliteStorageFailure } from '../../sqlite/sqlite-read-failure'

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
      const result = await compareOnce(readers, compare.sessionId, stopped, report)
      // No original, stopping, or this file failing: no other chat would fare better this launch.
      if (!result) {
        return
      }
      if ('error' in result || result.revision === compare.revision) {
        await writer.maintain({ kind: 'legacy-compare-settle', ...compare, ...result })
      }
    }
    after = page.compares.at(-1)!.sessionId
  }
}

/**
 * This file's own failures, contention and stopping leave the compare for the next launch. A reader
 * that exits gets one retry, since another request may have taken it down; a second exit is this
 * chat's, absorbed with its error so it never reruns into the same crash.
 */
async function compareOnce(
  readers: Pick<JournalSqlReaderPool, 'compareLegacyChat'>,
  sessionId: string,
  stopped: () => boolean,
  report: (error: unknown, sessionId: string) => void
): Promise<Awaited<ReturnType<JournalSqlReaderPool['compareLegacyChat']>>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readers.compareLegacyChat(sessionId)
    } catch (error) {
      report(error, sessionId)
      if (stopped() || isSqliteStorageFailure(error) || isSqliteCorruption(error)) {
        return null
      }
      if (attempt > 0) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  }
}
