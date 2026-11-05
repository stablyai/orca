import type { HistoryReader } from './agent-session-history-page-bounds'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session/agent-session-wire'
import type { SubscriberFieldState } from './agent-session-subscriber-frame-fields'

export type AgentSessionSubscribeInput = {
  commandsOnRequest?: boolean
  id: string
  sessionId: string
  emit: (event: AgentSessionSubscribeEvent) => void
  cursor?: AgentJournalCursor
  /** Bound each frame to the phone bridge’s limit; RPC enables this for every phone. */
  boundedFrames?: boolean
  projectQueuePublication?: SubscriberFieldState['projectQueuePublication']
  projectQueuePublicationSteps?: SubscriberFieldState['projectQueuePublicationSteps']
  projectJournalEventSteps?: SubscriberFieldState['projectJournalEventSteps']
  readHistorySnapshot?: HistoryReader['snapshot']
  readHistorySnapshotSteps?: HistoryReader['snapshotSteps']
  readQueueSourceIds?: HistoryReader['queueSourceIds']
  projectJournalEvent?: SubscriberFieldState['projectJournalEvent']
  readsCurrentRequests?: boolean
  /** False for desktops that need exact replay to keep send echoes and current requests. */
  snapshotCatchUp?: boolean
}
