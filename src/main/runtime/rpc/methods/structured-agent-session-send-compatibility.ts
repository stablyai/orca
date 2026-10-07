import {
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { agentSessionSendSubmission } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from '../../../native-chat/agent-session-wire/structured-agent-session-send-settlement'
import type { RpcContext } from '../core'
import { requireStructuredHost, structuredCallerFor } from './structured-agent-session-gate'

/**
 * A send answers once the host accepts it. A client that predates that answer cannot show a
 * message rejected after it, so its reply is held until the message is handed over or rejected —
 * or queued behind a running command such as `/compact`, which could outlast the client's own
 * request timeout; one that predates pending replies at all waits, as before, for the provider's
 * answer.
 */
export async function sendStructuredAgentSessionForClient(
  params: Parameters<StructuredAgentSessionHost['send']>[1],
  context: RpcContext
) {
  const host = requireStructuredHost(context)
  // A client's own send: a restart or a close keeps it as a card if it never reached the agent.
  const result = await host.send(structuredCallerFor(context), { ...params, userSend: true })
  const capabilities = context.clientCapabilities ?? []
  if (
    !result.ok ||
    // A queued answer only ever reaches a capable client, which renders it as-is.
    agentSessionSendSubmission(result.value)?.dispatchState !== 'pending' ||
    context.clientKind === undefined ||
    capabilities.includes(AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY)
  ) {
    return result
  }
  // The start that used to run before the reply now runs after acceptance, so both waits cover it.
  const settled = await host.waitForSendSettlement(
    params.envelope.sessionId,
    result.value.clientMessageId,
    {
      until: capabilities.includes(AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY)
        ? 'handed-over-or-behind-command'
        : 'answered',
      budgetMs: STRUCTURED_AGENT_SESSION_START_WAIT_MS,
      ...(context.signal ? { signal: context.signal } : {})
    }
  )
  return settled ? { ...result, ...settled } : result
}
