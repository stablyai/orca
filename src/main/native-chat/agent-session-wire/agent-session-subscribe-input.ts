import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import type { SubscriberFieldState } from './agent-session-subscriber-frame-fields'

export type AgentSessionSubscribeInput = {
  id: string
  sessionId: string
  emit: (event: AgentSessionSubscribeEvent) => void
  cursor?: AgentJournalCursor
  /** Every frame to fit a phone's bridge frame; the RPC sets it for every phone. */
  boundedFrames?: boolean
  projectQueuePublication?: SubscriberFieldState['projectQueuePublication']
  readsCurrentRequests?: boolean
  /** False for desktops that need exact replay to keep send echoes and current requests. */
  snapshotCatchUp?: boolean
}
