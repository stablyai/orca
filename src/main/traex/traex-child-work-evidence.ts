import type {
  AgentChildWorkEvidence,
  AgentChildWorkLiveObservation
} from '../../shared/agent-status/child-work/agent-status-child-work-evidence'
import type { AgentChildWorkOutcome } from '../../shared/agent-status/child-work/agent-status-child-work'

export type TraexChildAgent = {
  id: string
  parentId: string
  label?: string
  runId: string
  turnId: string | null
  state: 'working' | 'waiting' | 'done'
  outcome?: AgentChildWorkOutcome
  totalTokens?: number
  lastMessage?: string
  operation: AgentChildWorkLiveObservation['operation']
}

export type TraexChildCommand = {
  id: string
  threadId: string
  turnId: string | null
  processId?: string
  description?: string
  background: boolean
}

export function traexChildAgentEvidence(
  agent: TraexChildAgent,
  threadId: string
): AgentChildWorkEvidence {
  const id = agent.id
  const handle = { idKind: 'thread_id' as const, id, runId: agent.runId }
  return agent.state === 'done'
    ? {
        type: 'ended',
        observedAt: Date.now(),
        handle,
        outcome: agent.outcome ?? 'unknown',
        ...(agent.lastMessage ? { lastMessage: agent.lastMessage } : {}),
        ...(agent.totalTokens !== undefined ? { totalTokens: agent.totalTokens } : {})
      }
    : {
        type: 'live',
        observedAt: Date.now(),
        child: {
          handle,
          kind: 'agent',
          residency: 'background',
          state: agent.state,
          stoppable: true,
          ...(agent.label ? { description: agent.label } : {}),
          ...(agent.parentId !== threadId ? { ownerId: agent.parentId } : {}),
          ...(agent.totalTokens !== undefined ? { totalTokens: agent.totalTokens } : {}),
          ...(agent.lastMessage ? { lastMessage: agent.lastMessage } : {}),
          operation: agent.operation
        }
      }
}
export function traexChildCommandEvidence(
  command: TraexChildCommand,
  threadId: string,
  terminalSupport: string
): AgentChildWorkEvidence {
  return {
    type: 'live',
    observedAt: Date.now(),
    child: {
      handle: { idKind: 'task_id', id: command.id },
      kind: 'command',
      state: 'working',
      residency: command.background ? 'background' : 'foreground',
      stoppable: terminalSupport === 'supported' && command.background && !!command.processId,
      ...(command.description ? { description: command.description } : {}),
      ...(command.threadId !== threadId ? { ownerId: command.threadId } : {})
    }
  }
}
