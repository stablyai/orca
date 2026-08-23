// What attach needs from the host, named so the host cannot grow attach's dependencies unnoticed.

import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'

export type StructuredAgentSessionAttachContext = {
  deps: StructuredAgentSessionHostDeps
  runtimeState: StructuredAgentSessionHostRuntimeState
  sessions: Map<string, StructuredAgentSessionHostSession>
  subscribers: AgentSessionSubscribers
  tasks: StructuredAgentSessionTaskQueue
  reconcileLeases: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
}
