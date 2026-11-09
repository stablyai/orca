import type { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { AgentJournalSnapshot } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult,
  AgentSessionHistoryPage
} from '../../../../../shared/agent-session/agent-session-wire'
import type { HistoryReader } from './agent-session-history-page-bounds'
import { heldQueuedImageHistoryPolicy } from './agent-session-queued-image-reader'
import { CLIENT_HISTORY_READER } from './agent-session-item-wire-form'

export type AgentSessionHistoryScope = 'every-agent' | 'own-agent'

/** The worker chooses and bounds rows before advancing the page cursor. */
export async function readAgentSessionHistory(
  journal: SqlAgentSessionJournal,
  request: AgentSessionHistoryRequest,
  {
    scope = 'every-agent',
    reader = CLIENT_HISTORY_READER,
    rowReplay = false
  }: {
    scope?: AgentSessionHistoryScope
    reader?: HistoryReader
    rowReplay?: boolean
  } = {}
): Promise<AgentSessionHistoryResult> {
  const read = async (): Promise<AgentSessionHistoryResult> => {
    const result = await journal.history({
      ...request,
      scope,
      rowReplay,
      reader: {
        form: reader.wireForm ?? 'client',
        budgetBytes: reader.budgetBytes,
        ...(reader.queueSourceIds
          ? { queuedImages: await heldQueuedImageHistoryPolicy(journal) }
          : {})
      }
    })
    return {
      ...result,
      page: await projectPage(
        journal,
        result.page,
        reader,
        request.direction === 'after' && result.ok
      )
    }
  }
  return reader.queueSourceIds ? journal.readInOrder(read) : read()
}

export function createAgentSessionCatchUpReader(
  journal: SqlAgentSessionJournal,
  reader: HistoryReader = CLIENT_HISTORY_READER
): (request: AgentSessionHistoryRequest) => Promise<AgentSessionHistoryResult> {
  return (request) => readAgentSessionHistory(journal, request, { reader, rowReplay: true })
}

export async function readAgentSessionHydrationPage(
  journal: SqlAgentSessionJournal,
  fence?: number,
  reader: HistoryReader = CLIENT_HISTORY_READER
): Promise<AgentSessionHistoryPage> {
  const read = async () => {
    const result = await journal.history({
      direction: 'hydrate',
      fence,
      reader: {
        form: reader.wireForm ?? 'client',
        budgetBytes: reader.budgetBytes,
        ...(reader.queueSourceIds
          ? { queuedImages: await heldQueuedImageHistoryPolicy(journal) }
          : {})
      }
    })
    return projectPage(journal, result.page, reader, false)
  }
  return reader.queueSourceIds ? journal.readInOrder(read) : read()
}

async function projectPage(
  journal: SqlAgentSessionJournal,
  page: AgentSessionHistoryPage,
  reader: HistoryReader,
  forward: boolean
): Promise<AgentSessionHistoryPage> {
  if (!reader.snapshot) {
    return page
  }
  const snapshot: AgentJournalSnapshot = {
    sessionId: page.sessionId,
    cursor: page.liveCursor ?? page.window.nextCursor,
    items: page.items,
    submissions: page.submissions
  }
  const touched = forward
    ? new Set([...page.items.map((item) => item.itemId), ...page.removedItemIds])
    : undefined
  const projected = await reader.snapshot(journal, snapshot, touched)
  return {
    ...page,
    items: projected.items.map((item) => reader.form(item).item),
    submissions: projected.submissions
  }
}
