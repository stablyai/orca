import type { PromptStandingRead } from '../agent-session-wire/observations/structured-agent-session-prompt-standing'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionLatestTurn } from '../../../shared/agent-session/agent-session-wire'
import type { HostUsageLimitCut } from '../agent-session-wire/recovery/structured-agent-session-usage-limit-chain'
import type { NativeChatOrcaStopCut } from '../../../shared/native-chat/transcript/continuation/native-chat-orca-stop-cut'
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

export type JournalCurrentWorkAuthority = Omit<
  JournalWorkAuthority,
  'stop' | 'stopRevision' | 'reopenFloor'
>

export type JournalObserverRead = {
  authority: JournalWorkAuthority
  start: number
  floor?: number
  firstInputSubmissionKey: string | null
  /** A bot's session, whose quiet-marker answers the preview skips. */
  botSession?: true
}

export type JournalObserverResult = {
  cursor: AgentJournalCursor
  physicalCursor: AgentJournalCursor
  lastActivityAt: number
  authority: JournalWorkAuthority
  /** goalContinues: the live provider starts the next turn itself, so a settled success is not the end. */
  state: JournalStatusState & { goalContinues?: true }
  indicators: JournalStatusIndicators
  usageLimitCut: HostUsageLimitCut | null
  orcaStopCut: NativeChatOrcaStopCut | null
  work: {
    promptStandings?: PromptStandingRead
    liveFence: number | null
    allowsObservation: boolean
    working: boolean
    commandAdmission: { promptPending: boolean; owesSend: boolean; handoverOwesSend: boolean }
    owesAnySend: boolean
    owedEnteredSubmissions: AgentJournalSubmission[]
    owedSendingSubmissions: AgentJournalSubmission[]
    activeTurn: { item: AgentJournalRenderItem; turnId: string } | null
    /** The message that opened the running turn (one sent into it joined it); null when none runs. */
    activeTurnOpener?: AgentJournalRenderItem | null
    latestTurn: AgentSessionLatestTurn | null
    actionablePrompts: AgentJournalRenderItem[]
    restatedSubmissions: AgentJournalSubmission[]
    viewKey: string
    workViewKey: string
  }
}

/** Copy the finite authority contract; compare live sets independently of insertion order. */
export function copyJournalWorkAuthority(authority: JournalWorkAuthority): JournalWorkAuthority {
  return {
    ...copyJournalCurrentWorkAuthority(authority),
    reopenFloor: authority.reopenFloor && {
      epoch: authority.reopenFloor.epoch,
      sequence: authority.reopenFloor.sequence
    },
    stopRevision: authority.stopRevision,
    stop: structuredClone(authority.stop)
  }
}

export function copyJournalCurrentWorkAuthority(
  authority: JournalCurrentWorkAuthority
): JournalCurrentWorkAuthority {
  const { record, ended, replaced, child, openedThrough } = authority
  return {
    handle: authority.handle,
    record:
      record === null
        ? null
        : {
            currentFence: record.currentFence,
            ownerObservation: {
              claimStatus: record.ownerObservation.claimStatus,
              unreconciled: record.ownerObservation.unreconciled,
              handoffStage: record.ownerObservation.handoffStage
            }
          },
    ended: ended && { fence: ended.fence, rootGone: ended.rootGone, cause: ended.cause },
    replaced: replaced && { fence: replaced.fence, ...(replaced.kept ? { kept: true } : {}) },
    child:
      child === null || child === undefined
        ? child
        : {
            fence: child.fence,
            heldSends: child.heldSends === undefined ? undefined : [...child.heldSends].sort()
          },
    handingOver: [...authority.handingOver].sort(),
    continuingUnadmitted: [...authority.continuingUnadmitted].sort(),
    finalizing: [...authority.finalizing].sort(),
    openedThrough: { epoch: openedThrough.epoch, sequence: openedThrough.sequence },
    operationalRevision: authority.operationalRevision
  }
}
