import { AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { RpcContext } from '../core'
import { requireStructuredHost, structuredCallerFor } from './structured-agent-session-gate'

export async function sendStructuredAgentSessionForClient(
  params: Parameters<StructuredAgentSessionHost['send']>[1],
  context: RpcContext
) {
  const host = requireStructuredHost(context)
  const result = await host.send(structuredCallerFor(context), params)
  if (
    !result.ok ||
    result.value.submission.dispatchState !== 'pending' ||
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY)
  ) {
    return result
  }
  const settled = await host.waitForSendSettlement(
    params.envelope.sessionId,
    result.value.clientMessageId,
    context.signal
  )
  return settled ? { ...result, ...settled } : result
}
