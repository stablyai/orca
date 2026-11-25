import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { readJournalSqlWorkFrame } from '../../agent-session-journal/journal-sql-work-answer'
import { withPublishedWork } from '../observations/agent-session-published-work'
import { heldStructuredAgentSessionWorkAuthority } from '../observations/structured-agent-session-host-current-work'
import { StructuredAgentSessionObservedWork } from '../observations/structured-agent-session-observed-work'
import { readAgentSessionHydrationFrame } from '../publication/history/agent-session-history-page'
import type { HistoryReader } from '../publication/history/agent-session-history-page-bounds'
import { captureRequestFrame } from '../publication/subscribers/agent-session-subscriber-frame-capture'

/** The hydration page, the work overlaid on it and the reply cursor, at one held lane position. */
export async function captureAttachedHydration(
  store: AgentSessionRecordStore,
  sessionId: string,
  journal: AgentSessionJournal,
  fence: number,
  reader: HistoryReader
) {
  const authority = () =>
    heldStructuredAgentSessionWorkAuthority(store, sessionId, journal, undefined)
  return captureRequestFrame(journal, () =>
    journal.readInOrder(async (reads) => {
      const frame = await readJournalSqlWorkFrame(journal, authority, async (work) => {
        const read = await readAgentSessionHydrationFrame(journal, fence, reader, work, true)
        return { value: read.result, ...(read.work ? { work: read.work } : {}) }
      })
      if (!frame) {
        return undefined
      }
      if (frame.answer.result.kind !== 'state') {
        throw new Error('journal work reader returned another answer')
      }
      const work = new StructuredAgentSessionObservedWork(
        journal,
        frame.answer.result.state,
        frame.answer.cursor,
        frame.answer
      )
      return { page: withPublishedWork(frame.value, work), cursor: await reads.cursor() }
    })
  )
}
