import type { AdoptedTranscriptSource } from '../../agent-session-journal/history-import/adopted-transcript-source'
import type { JournalReplacementItem } from '../../agent-session-journal/context-epochs/journal-epoch-replacement'
import type { AgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'

export type ReadStructuredAgentConversationHistory = (input: {
  sessionId: string
  agent: string
  accountHome: AgentSessionAccountHome
  providerSessionId: string
  transcriptPath: string
  source?: AdoptedTranscriptSource
  signal?: AbortSignal
}) => Promise<{ items: JournalReplacementItem[]; sourceEmpty: boolean } | null>
