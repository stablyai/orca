import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { createHash } from 'node:crypto'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRewindParams } from '../../../shared/agent-session-rewind'
import type { StructuredAgentSessionAcquireInput } from './structured-agent-session-adapter'
import { attachFingerprintFields } from './structured-agent-session-attach'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { attachStructuredAgentSession } from './structured-agent-session-attach-orchestration'
import { rewindRefusal } from './structured-rewind-refusal'

/** Runs within the rewind's session queue; acquisition still uses the normal reservation CAS. */
export async function replaceClaudeRewindOwner(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionRewindParams,
  rewind: NonNullable<StructuredAgentSessionAcquireInput['rewind']>
): Promise<{ ok: true; items?: never } | ReturnType<typeof rewindRefusal>> {
  const sessionId = params.envelope.sessionId
  const session = context.sessions.get(sessionId)!
  if (!(await context.deps.adapter.closeSession?.(sessionId))) {
    return rewindRefusal('outcome-unknown')
  }
  session.hasProviderChild = false
  context.publishStatus?.(sessionId)
  const head = agentSessionProviderHandleChainHead(
    context.deps.store.getRecord(sessionId)!.providerHandleChain
  )?.handle
  if (head?.provider !== 'claude' || !head.leafUuid) {
    return rewindRefusal('invalid-target')
  }
  rewind = { ...rewind, previousLeafUuid: head.leafUuid }
  const attach = async (intent: typeof rewind | undefined, stage: string) => {
    const current = context.deps.store.getRecord(sessionId)!
    const operationId = `${params.envelope.clientOperationId.split('-')[0]}-${createHash('sha256')
      .update(JSON.stringify([callerKey, params.envelope.clientOperationId, stage]))
      .digest('hex')
      .slice(0, 32)}`
    const attachParams = {
      ...session.params,
      envelope: {
        sessionId,
        clientOperationId: operationId,
        expectedRuntimeFence: current.lease.runtimeFence,
        payloadFingerprint: ''
      }
    }
    attachParams.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
      method: 'agentSession.attach',
      sessionId,
      fields: attachFingerprintFields(attachParams)
    })
    return attachStructuredAgentSession(
      {
        ...context,
        serialize: (_id, run) => run()
      },
      callerKey,
      attachParams,
      undefined,
      intent
    )
  }
  const result = await attach(rewind, 'rewind')
  if (result.ok) {
    return { ok: true } as const
  }
  if (
    result.refusal.rewindReason === 'provider-refused' ||
    result.refusal.rewindReason === 'proof-mismatch'
  ) {
    const recovered = await attach(undefined, 'resume')
    if (!recovered.ok) {
      return rewindRefusal('outcome-unknown')
    }
    return rewindRefusal(result.refusal.rewindReason)
  }
  return rewindRefusal(result.refusal.rewindReason ?? 'outcome-unknown')
}
