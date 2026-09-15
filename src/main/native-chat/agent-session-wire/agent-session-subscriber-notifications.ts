import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionHandoffStatus,
  AgentSessionHistoryPage,
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { readAgentSessionHydrationPage } from './agent-session-history-page'

export type AgentSessionSubscriber = {
  id: string
  sessionId: string
  emit: (event: AgentSessionSubscribeEvent) => void
  cursor: AgentJournalCursor
  fence: number
  commands?: AgentSessionSlashCommand[] | null
}

type NotificationRecipients = {
  sessionId: string
  fence: number
  hostNow: number
  subscribers: readonly AgentSessionSubscriber[]
  emit: (subscriber: AgentSessionSubscriber, event: AgentSessionSubscribeEvent) => void
}

export function publishAgentSessionHandoff(
  input: NotificationRecipients & {
    handoff: AgentSessionHandoffStatus
    readJournal?: (sessionId: string) => AgentSessionJournal | undefined
    projectPage?: (sessionId: string, page: AgentSessionHistoryPage) => AgentSessionHistoryPage
  }
): void {
  const { sessionId, fence, handoff, hostNow } = input
  let projectedPage: AgentSessionHistoryPage | undefined
  for (const subscriber of input.subscribers) {
    const journal = subscriber.fence !== fence ? input.readJournal?.(sessionId) : undefined
    if (journal) {
      const page = projectedPage ?? projectHandoffPage(sessionId, journal, fence, input.projectPage)
      projectedPage = page
      input.emit(subscriber, { type: 'snapshot', sessionId, page, fence, handoff, hostNow })
      subscriber.cursor = page.liveCursor ?? page.window.nextCursor
      subscriber.fence = fence
      continue
    }
    input.emit(subscriber, {
      type: 'batch',
      sessionId,
      batch: emptyAgentSessionBatch(subscriber.cursor),
      fence,
      handoff,
      hostNow
    })
    subscriber.fence = fence
  }
}

function projectHandoffPage(
  sessionId: string,
  journal: AgentSessionJournal,
  fence: number,
  projectPage?: (sessionId: string, page: AgentSessionHistoryPage) => AgentSessionHistoryPage
): AgentSessionHistoryPage {
  const page = readAgentSessionHydrationPage(journal, fence)
  return projectPage?.(sessionId, page) ?? page
}

export function publishAgentSessionBackgroundTasks(
  input: NotificationRecipients & { state: AgentSessionBackgroundTaskState | null }
): void {
  const { sessionId, fence, hostNow, state } = input
  for (const subscriber of input.subscribers) {
    input.emit(subscriber, {
      type: 'batch',
      sessionId,
      batch: emptyAgentSessionBatch(subscriber.cursor),
      fence,
      backgroundTasks: state,
      hostNow
    })
    subscriber.fence = fence
  }
}
