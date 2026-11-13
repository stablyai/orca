import type { AgentJournalItemIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type {
  TraexAppServerConnection,
  TraexConnectionHandlers
} from './traex-app-server-connection'
import type { TraexLaunch } from './traex-launch-resolution'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { StructuredAgentSessionChildWorkProducer } from '../native-chat/agent-session-wire/observations/structured-agent-session-subagent-rows'
import type { AgentChildWorkEvidence } from '../../shared/agent-status/child-work/agent-status-child-work-evidence'

export type TraexSessionDeps = {
  logger?: StructuredAgentSessionLogger
  onLifecycle: (event: StructuredAgentSessionLifecycleEvent) => void
  onSettled: (clientMessageId: string, identity: AgentJournalItemIdentity) => void
  connect?: (launch: TraexLaunch, handlers: TraexConnectionHandlers) => TraexAppServerConnection
  onChildWorkEvidence?: (
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    producer?: StructuredAgentSessionChildWorkProducer
  ) => void
  onModeChanged?: (sessionId: string, fence: number, mode: 'plan' | 'default') => Promise<void>
}

export type TraexPendingSend = {
  clientMessageId: string
  requestedAt: number
  turnId?: string
  unknown: boolean
}
