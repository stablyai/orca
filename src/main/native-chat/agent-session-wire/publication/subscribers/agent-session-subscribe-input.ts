import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { StructuredAgentSessionObservedWork } from '../../observations/structured-agent-session-observed-work'
import type { StructuredAgentSessionWorkFrameReader } from '../../observations/structured-agent-session-status-reader'
import type {
  SubscriberFieldHooks,
  SubscriberFieldState
} from './agent-session-subscriber-frame-fields'
import type { CurrentRequestsSubscriber } from '../../observations/agent-session-current-requests'
import type { ForkMarker } from '../history/agent-session-fork-marker'
import type { HistoryReader } from '../history/agent-session-history-page-bounds'
import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'

export type AgentSessionSubscribeInput = {
  commandsOnRequest?: boolean
  id: string
  sessionId: string
  emit: (event: AgentSessionSubscribeEvent) => void
  /** Ends the subscriber's stream once the host stops delivering to it, so the client resubscribes. */
  end?: (cause: unknown) => void
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
  end?: (cause: unknown) => void
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

export type AgentSessionSubscribersHooks = SubscriberFieldHooks & {
  readLiveText?: (sessionId: string) => readonly AgentJournalRenderItem[]
  readForkMarker?: (sessionId: string) => ForkMarker | undefined
  readForkJournal?: (sessionId: string) => AgentSessionJournal | undefined
  onJournalPublished?: (sessionId: string, journal: AgentSessionJournal) => void
  readCurrentWork?: (
    sessionId: string,
    journal: AgentSessionJournal
  ) => Promise<StructuredAgentSessionObservedWork | null>
  readWorkFrame?: StructuredAgentSessionWorkFrameReader
  now?: () => number
}
