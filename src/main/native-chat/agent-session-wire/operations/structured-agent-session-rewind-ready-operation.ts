import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { ReadyOperationPlan } from './structured-agent-session-ready-operation-plan'
import type { ReadyOperationSelection } from './structured-agent-session-operation-child'
import { rewindInDoubt } from './structured-agent-session-send-preparation'
import { runWithReadyStructuredAgentSessionOperation } from './structured-agent-session-ready-operation'

export async function runAfterRewindStart<T>(
  context: StructuredAgentSessionMutationContext,
  callerKey: string,
  envelope: AgentSessionMutationEnvelope,
  plan: ReadyOperationPlan<T>,
  run: (selection: ReadyOperationSelection) => Promise<AgentSessionMutationResult<T>>
): Promise<AgentSessionMutationResult<T>> {
  return runWithReadyStructuredAgentSessionOperation(context, callerKey, envelope, plan, run, {
    needsAgent: rewindInDoubt
  })
}
