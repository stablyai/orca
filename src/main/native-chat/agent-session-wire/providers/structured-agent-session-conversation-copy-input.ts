import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { NativeCopyCoverage } from '../../agent-session-journal/context-epochs/journal-history-origin'

export type StructuredAgentSessionConversationCopyInput = {
  current?: true
  /** A durable native-copy receipt reopens this copy instead of forking again. */
  copiedSessionId?: string
  copiedCoverage?: NativeCopyCoverage
  /** Persist the confirmed child before optional Goal or transcript I/O. */
  onCopyConfirmed?: (sessionId: string) => Promise<void>
  record?: AgentSessionRecord
  checkpoint?: {
    selectedItemId: string
    settled: boolean
    beforeMessage?: { sessionId: string; uuid: string }
    throughMessage?: { sessionId: string; uuid: string }
    rootMessage?: { sessionId: string; uuid: string }
    turnId?: string
  }
  title?: string
  signal?: AbortSignal
  identity: AgentSessionJournalIdentity
  providerSessionId: string
  accountHome: AgentSessionAccountHome
}
