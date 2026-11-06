import type { CurrentRequestsSubscriber } from '../../observations/agent-session-current-requests'
import type { ForkMarker } from '../history/agent-session-fork-marker'
import type { HistoryReader } from '../history/agent-session-history-page-bounds'
import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'
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

export type AgentSessionSubscriberEmit = (event: AgentSessionSubscribeEvent) => void
export type Subscriber = {
  id: string
  emit: AgentSessionSubscriberEmit
  cursor: AgentJournalCursor
  fence: number
  forkMarkerView?: string
  readForkMarker?: () => ForkMarker | undefined
  readHistorySnapshot?: HistoryReader['snapshot']
  readQueueSourceIds?: HistoryReader['queueSourceIds']
  snapshotCatchUp?: boolean
  /** The current-work view the last frame's fields were read under
   *  (`StructuredAgentSessionCurrentWork.viewKey`); a change with no row still owes a frame. */
  workView?: string
  historyView?: string
} & CurrentRequestsSubscriber &
  SubscriberFieldState
