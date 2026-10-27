import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { UnsentSendHold } from '../agent-session-journal/journal-unsent-send-hold'
import type { AgentChatPermissionChoice } from '../../../shared/agent-chat-permission-mode'
import type { StructuredAgentSessionStartFlights } from './structured-agent-session-start-flight'
import type { StructuredAgentSessionDeliveryOrder } from './structured-agent-session-delivery-order'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { StructuredAgentSessionRanRecorder } from './structured-agent-session-ran-options'
import type { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'
import type { StructuredAgentSessionStartClaim } from './structured-agent-session-agent-start'
import type { StructuredAgentSessionStartReadiness } from './structured-agent-session-startup-attempt'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'

export type StructuredAgentSessionDeliveryLoopDeps = {
  startFlights?: Pick<StructuredAgentSessionStartFlights, 'get'>
  deliveryOrder: StructuredAgentSessionDeliveryOrder
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  adapter: StructuredAgentSessionAdapter
  agents: StructuredAgentRegistry
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** Track from enqueue so quit drains any child the start may create. */
  trackStart: <T>(start: Promise<T>) => Promise<T>
  startProviderChild: (sessionId: string, startedFor: string) => StructuredAgentSessionStartClaim
  /** Retire mismatched login/permission children under serialization. */
  retireOutgrownChild: (
    sessionId: string,
    continuingId?: string,
    next?: AgentJournalSubmission
  ) => Promise<void>
  immediatePermission?: (sessionId: string) => AgentChatPermissionChoice | null
  retainedWork?: (sessionId: string, continuingId: string) => boolean
  readiness: (
    sessionId: string,
    child: StructuredAgentSessionProviderChildIdentity
  ) => StructuredAgentSessionStartReadiness | null
  conversationFence: (sessionId: string) => number
  /** Settle sends covered by partial close; later sends remain eligible. False means settlement failed. */
  closeWhatTheUserClosed: (sessionId: string) => Promise<boolean>
  failureTextContext: (sessionId: string) => AgentSessionFailureWordsContext
  logger: StructuredAgentSessionLogger
  record: (sessionId: string) => AgentSessionRecord | null
  currentWork: (sessionId: string) => StructuredAgentSessionCurrentWork | null
  /** Publish row-free changes in current work. */
  workChanged?: (sessionId: string) => void
  holdClosedInput?: (
    sessionId: string,
    clientMessageId: string,
    fence: number,
    cause: UnsentSendHold['cause']
  ) => Promise<void>
  settleLeftovers?: (sessionId: string, owner: () => void) => Promise<void>
  readChildWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  childWorkOpen: (sessionId: string) => boolean
  stopping: (sessionId: string) => boolean
  now: () => number
  acquireAborts: Pick<StructuredAgentSessionAcquireAborts, 'begin'>
  recordRanOptions?: StructuredAgentSessionRanRecorder
}
