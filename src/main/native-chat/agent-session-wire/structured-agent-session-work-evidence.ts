import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionConversationView } from '../../../shared/agent-session/lifecycle/agent-session-conversation-view'

export type StructuredAgentSessionWorkEvidence = {
  record: Pick<AgentSessionConversationView, 'ownerObservation' | 'currentFence'> | null
  ended?: StructuredAgentSessionSeenEnd
  revision?: number
  replaced?: StructuredAgentSessionReplacedEnd | undefined
  /** Absent means the host has no child observation. */
  child?: { fence: number; heldSends?: () => ReadonlySet<string> | undefined } | null
}

/** Replaced runtimes granted all fences through this boundary. */
export type StructuredAgentSessionReplacedEnd = { fence: number }

export type StructuredAgentSessionSeenEnd = {
  fence: number
  rootGone?: boolean
  cause?: string
}

export type StructuredAgentSessionCurrentWorkJournal = Pick<
  AgentSessionJournal,
  'runningTurn' | 'itemFence' | 'visitItems' | 'submissions' | 'wroteBeforeOpen' | 'item' | 'cursor'
> &
  Partial<Pick<AgentSessionJournal, 'readSince' | 'visitItemSteps'>> & {
    inputOrder: Pick<AgentSessionJournal['inputOrder'], 'recoverableSubmissions'> &
      Partial<
        Pick<
          AgentSessionJournal['inputOrder'],
          'recoverableSubmissionValues' | 'recoverableSubmissionSteps'
        >
      >
  }
