import { createHash } from 'node:crypto'
import { isDefinitiveAgentSessionCreateRefusal } from '../../../shared/agent-session-definitive-refusal'
import { parseAgentSessionOperationTimestamp } from '../../../shared/agent-session-host-authority'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

export async function attachConversationClearReplacement(input: {
  host: Pick<StructuredAgentSessionHost, 'attach'>
  store: StructuredAgentSessionHost['deps']['store']
  sourceSessionId: string
  replacementSessionId: string
  callerKey: string
  operationId: string
  source: Pick<
    AgentSessionRecord,
    'location' | 'accountHome' | 'provider' | 'launchArgs' | 'options'
  >
}): Promise<string | null> {
  const attach: AgentSessionAttachParams = {
    envelope: {
      sessionId: input.replacementSessionId,
      clientOperationId: `${parseAgentSessionOperationTimestamp(input.operationId)}-${createHash(
        'sha256'
      )
        .update(JSON.stringify([input.sourceSessionId, input.callerKey, input.operationId]))
        .digest('hex')
        .slice(0, 32)}`,
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    location: input.source.location,
    accountHome: input.source.accountHome,
    provider: input.source.provider,
    agent: input.source.provider,
    runtimeKind: 'native',
    launchArgs: input.source.launchArgs,
    options: input.source.options
  }
  attach.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
    method: 'agentSession.attach',
    sessionId: input.replacementSessionId,
    fields: attachFingerprintFields(attach)
  })
  const acquired = await input.host.attach({ callerKey: input.callerKey }, attach)
  if (acquired.ok) {
    return null
  }
  if (
    !isDefinitiveAgentSessionCreateRefusal(acquired.refusal.code) &&
    input.store.getRecord(input.replacementSessionId)?.lease.claimStatus !== 'released'
  ) {
    throw new Error(acquired.refusal.message)
  }
  return acquired.refusal.message
}
