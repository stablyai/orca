import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionLatestTurn } from '../../../shared/agent-session/agent-session-wire'
import type { NativeChatUsageLimitCut } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import type { NativeChatOrcaStopCut } from '../../../shared/native-chat/native-chat-orca-stop-cut'
import type { StructuredAgentSessionWorkEvidence } from '../agent-session-wire/observations/structured-agent-session-work-evidence'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import type { JournalStatusState } from './journal-status-state'
import type { JournalStatusIndicators } from './journal-status-indicators'

/** Only live owners and sets cross the read boundary; no callback or history mirror does. */
export type JournalWorkAuthority = {
  handle: string
  record: StructuredAgentSessionWorkEvidence['record']
  ended?: StructuredAgentSessionWorkEvidence['ended']
  replaced?: StructuredAgentSessionWorkEvidence['replaced']
  child?: { fence: number; heldSends?: string[] } | null
  handingOver: string[]
  continuingUnadmitted: string[]
  finalizing: string[]
  openedThrough: AgentJournalCursor
  reopenFloor: AgentJournalCursor | null
  operationalRevision: number
  stopRevision: number
  stop: JournalLatestStop | null
}

export type JournalObserverRead = {
  authority: JournalWorkAuthority
  start: number
  floor: number
  firstInputSubmissionKey: string | null
}

export type JournalObserverResult = {
  cursor: AgentJournalCursor
  physicalCursor: AgentJournalCursor
  authority: JournalWorkAuthority
  state: JournalStatusState
  indicators: JournalStatusIndicators
  usageLimitCut: NativeChatUsageLimitCut | null
  orcaStopCut: NativeChatOrcaStopCut | null
  work: {
    liveFence: number | null
    allowsObservation: boolean
    working: boolean
    owesAnySend: boolean
    activeTurn: { item: AgentJournalRenderItem; turnId: string } | null
    latestTurn: AgentSessionLatestTurn | null
    actionablePrompts: AgentJournalRenderItem[]
    restatedSubmissions: AgentJournalSubmission[]
    viewKey: string
    workViewKey: string
  }
}
