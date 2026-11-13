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
import type { JournalDomainHistoryWork } from '../../../agent-session-journal/journal-domain-history-page'
import type { JournalSqlWorkResult } from '../../../agent-session-journal/journal-work-read'

export type AgentSessionHistoryScope = 'every-agent' | 'own-agent'

/** The worker chooses and bounds rows before advancing the page cursor. */
export async function readAgentSessionHistory(
  journal: SqlAgentSessionJournal,
  request: AgentSessionHistoryRequest,
  options: HistoryReadOptions = {}
): Promise<AgentSessionHistoryResult> {
  return (await readAgentSessionHistoryFrame(journal, request, options)).result
}

type HistoryReadOptions = {
  scope?: AgentSessionHistoryScope
  reader?: HistoryReader
  rowReplay?: boolean
}

export type AgentSessionHistoryFrame<T> = { result: T; work?: JournalSqlWorkResult }

/** The page and any requested work share one reader snapshot. `inLane`: the caller already holds
 *  the chat's command lane, which is not reentrant. */
export async function readAgentSessionHistoryFrame(
  journal: SqlAgentSessionJournal,
  request: AgentSessionHistoryRequest,
  { scope = 'every-agent', reader = CLIENT_HISTORY_READER, rowReplay = false }: HistoryReadOptions,
  work?: JournalDomainHistoryWork,
  inLane = false
): Promise<AgentSessionHistoryFrame<AgentSessionHistoryResult>> {
  const read = async (): Promise<AgentSessionHistoryFrame<AgentSessionHistoryResult>> => {
    const frame = await journal.history(
      {
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
      },
      work
    )
    return {
      ...frame,
      result: {
        ...frame.result,
        page: await projectPage(
          journal,
          frame.result.page,
          reader,
          request.direction === 'after' && frame.result.ok
        )
      }
    }
  }
  return reader.queueSourceIds && !inLane ? journal.readInOrder(read) : read()
}

/** Subscriber catch-up reads inside its held frame capture. */
export function createAgentSessionCatchUpReader(
  journal: SqlAgentSessionJournal,
  reader: HistoryReader = CLIENT_HISTORY_READER
): (
  request: AgentSessionHistoryRequest,
  work?: JournalDomainHistoryWork
) => Promise<AgentSessionHistoryFrame<AgentSessionHistoryResult>> {
  return (request, work) =>
    readAgentSessionHistoryFrame(journal, request, { reader, rowReplay: true }, work, true)
}

export async function readAgentSessionHydrationPage(
  journal: SqlAgentSessionJournal,
  fence?: number,
  reader: HistoryReader = CLIENT_HISTORY_READER
): Promise<AgentSessionHistoryPage> {
  return (await readAgentSessionHydrationFrame(journal, fence, reader)).result
}

export async function readAgentSessionHydrationFrame(
  journal: SqlAgentSessionJournal,
  fence?: number,
  reader: HistoryReader = CLIENT_HISTORY_READER,
  work?: JournalDomainHistoryWork,
  inLane = false
): Promise<AgentSessionHistoryFrame<AgentSessionHistoryPage>> {
  const read = async (): Promise<AgentSessionHistoryFrame<AgentSessionHistoryPage>> => {
    const frame = await journal.history(
      {
        direction: 'hydrate',
        fence,
        reader: {
          form: reader.wireForm ?? 'client',
          budgetBytes: reader.budgetBytes,
          ...(reader.queueSourceIds
            ? { queuedImages: await heldQueuedImageHistoryPolicy(journal) }
            : {})
        }
      },
      work
    )
    return { ...frame, result: await projectPage(journal, frame.result.page, reader, false) }
  }
  return reader.queueSourceIds && !inLane ? journal.readInOrder(read) : read()
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
