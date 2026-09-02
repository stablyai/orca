// What attaching needs from the host, named explicitly.
//
// Passing the host itself would let this quietly grow new dependencies; an explicit context makes
// each one a deliberate addition and keeps the orchestration testable without constructing a host.

import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentJournalResetReason } from '../../../shared/agent-session-journal-types'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'

export type StructuredAgentSessionAttachContext = {
  deps: StructuredAgentSessionHostDeps
  runtimeState: StructuredAgentSessionHostRuntimeState
  sessions: Map<string, StructuredAgentSessionHostSession>
  subscribers: {
    reset: (
      sessionId: string,
      journal: AgentSessionJournal,
      reset: AgentJournalResetReason,
      fence: number
    ) => void
    snapshot: (sessionId: string, journal: AgentSessionJournal, fence: number) => void
    publish: (sessionId: string, journal: AgentSessionJournal) => void
  }
  tasks: StructuredAgentSessionTaskQueue
  reconcileLeases: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
  /** Retries a durable provider-exit journal settlement before a new owner is reserved. */
  retryPendingSettlement?: (sessionId: string, params: AgentSessionAttachParams) => Promise<boolean>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
}
