import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session/failures/agent-session-failure-words'
export type StructuredAgentSessionRequestFailure = {
  sessionId: string
  agent: string
  kind: 'turn' | 'refused-send'
  id: string
  outcome: 'failure' | 'interruption'
  capturePendingOutput?: () => (() => boolean) | undefined
  death?: NonNullable<StructuredAgentSessionHostSession['lastEndedChild']> &
    AgentSessionFailureWordsContext
  read: () => Promise<AgentJournalSnapshot | null>
}

export type Baseline = ReturnType<AgentSessionJournal['cursor']> & {
  sessionId: string
  journal: AgentSessionJournal
  floor: number
  marks: Map<string, string>
  ended: StructuredAgentSessionHostSession['lastEndedChild']
}

export type StructuredRequestFailureDeps = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  onFailure: (failure: StructuredAgentSessionRequestFailure) => void
  capturePendingOutput?: StructuredAgentSessionAdapter['capturePendingOutput']
  wordsContext?: (sessionId: string) => AgentSessionFailureWordsContext
}
