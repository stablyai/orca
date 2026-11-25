import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  type AgentSessionInstructionBaseline,
  type AgentSessionInstructionPolicy,
  sameInstructionBaseline
} from '../../../../shared/agent-session/agent-session-instruction-policy'
import { agentSessionInstructionScope } from './agent-session-instruction-scope'

export type OpenedInstructionPolicy = {
  policy: AgentSessionInstructionPolicy
  snapshot: {
    botId: string
    standing: string
    digest: string
    baseline?: AgentSessionInstructionBaseline
  }
  context: { account: string; digest: string; filesIncluded: boolean }
  fence: number
  generation: string
}

export function recordOpenedInstructionPolicy(
  record: AgentSessionRecord,
  started: AgentSessionRecord,
  link: AgentSessionRecord['providerHandleChain'][number],
  { policy, context, snapshot, fence, generation }: OpenedInstructionPolicy
): AgentSessionRecord {
  if (
    policy.botId !== snapshot.botId ||
    policy.standing !== snapshot.standing ||
    (context.filesIncluded &&
      (policy.snapshot !== snapshot.digest ||
        !sameInstructionBaseline(policy.baseline, snapshot.baseline))) ||
    policy.scope !== agentSessionInstructionScope(record, context.account) ||
    snapshot.digest !== context.digest ||
    (!context.filesIncluded &&
      (record.instructionPolicy?.state !== 'delivered' ||
        record.instructionPolicy.operationId !== policy.operationId ||
        record.instructionPolicy.scope !== policy.scope ||
        record.instructionPolicy.snapshot !== policy.snapshot ||
        record.instructionPolicy.anchor !== record.providerHandleChain.at(-1)?.linkId)) ||
    policy.fence !== fence ||
    policy.generation !== generation ||
    policy.anchor !== link.linkId ||
    policy.nativeId !== link.handle.nativeId ||
    (record.instructionPolicy?.state === 'pending' &&
      record.instructionPolicy.operationId !== policy.operationId)
  ) {
    throw new Error('agent_session_checkpoint_stale')
  }
  return {
    ...started,
    instructionPolicy: {
      ...policy,
      anchor: started.providerHandleChain.at(-1)!.linkId,
      ...(!context.filesIncluded ? { baseline: record.instructionPolicy?.baseline } : {})
    }
  }
}
