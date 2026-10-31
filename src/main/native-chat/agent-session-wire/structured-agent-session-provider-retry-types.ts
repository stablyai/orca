import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type { AgentSessionTransientFailure } from '../../../shared/agent-session-provider-retry-policy'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

export type CurrentResult = {
  itemId: string
  turnId: string
  sequence: number
  role: 'predecessor' | 'execution'
  state: 'running' | 'ended'
  category?: AgentSessionTransientFailure
}
export type {
  ProducerTransition,
  ProviderRetryCompletion,
  ProviderRetryDisposition,
  View
} from './structured-agent-session-provider-retry-view'
export type Retry = {
  journal: AgentSessionJournal
  epoch: string
  fence: number
  child: NonNullable<StructuredAgentSessionHostSession['child']>
  currentResult?: CurrentResult
  offered?: { itemId: string; category?: AgentSessionTransientFailure; state?: 'start' | 'end' }
  options?: AgentSessionExecutionOptions
  attempt: number
  phase: 'candidate' | 'waiting' | 'starting' | 'running' | 'settled'
  startedTurnRef?: string
  written: boolean
  timer?: ReturnType<typeof setTimeout>
  abort: AbortController
}
export type ContinueInput = Parameters<
  NonNullable<StructuredAgentSessionAdapter['continueAfterTransientFailure']>
>[0]
