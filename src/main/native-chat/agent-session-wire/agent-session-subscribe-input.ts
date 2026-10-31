import type { HistoryReader } from './agent-session-history-page-bounds'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
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
  readHistorySnapshot?: HistoryReader['snapshot']
  readQueueSourceIds?: HistoryReader['queueSourceIds']
  projectJournalEvent?: SubscriberFieldState['projectJournalEvent']
  readsCurrentRequests?: boolean
  /** False for desktops that need exact replay to keep send echoes and current requests. */
  snapshotCatchUp?: boolean
}
