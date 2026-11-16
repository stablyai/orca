import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'

/**
 * Converted chats an older Orca may have continued, with no revision to compare, are compared one
 * per idle step on a reader. Each settles durably, so an interrupted run resumes next launch.
 */
export async function compareJournalLegacyChatsWhenIdle(
  writer: Pick<JournalSqlOwner, 'maintain'>,
  readers: Pick<JournalSqlReaderPool, 'database' | 'compareLegacyChat'>,
  boundary: () => Promise<boolean>,
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
      // A reader that can't answer leaves the compare for the next launch.
      let result: Awaited<ReturnType<JournalSqlReaderPool['compareLegacyChat']>>
      try {
        result = await readers.compareLegacyChat(compare.sessionId)
      } catch (error) {
        report(error, compare.sessionId)
        continue
      }
      if (result && ('error' in result || result.revision === compare.revision)) {
        await writer.maintain({ kind: 'legacy-compare-settle', ...compare, ...result })
      }
    }
    after = page.compares.at(-1)!.sessionId
  }
}
