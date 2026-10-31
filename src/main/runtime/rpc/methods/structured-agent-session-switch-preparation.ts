import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { z } from 'zod'
import type { RpcContext } from '../core'
import type { SwitchToChatParams, SwitchToTerminalParams } from './structured-agent-session-schemas'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import {
  ensureStructuredHostInstalled,
  requireStructuredSessionHost,
  requireStructuredHost,
  structuredCallerFor
} from './structured-agent-session-gate'
import { inPlaceSwitchEnabled } from '../../../../shared/structured-agent-cli-conversation-adoption'
import {
  switchRetainedOwner,
  switchConversationIdentity
} from './structured-agent-session-switch-source'
import { captureStructuredAgentCliSource } from '../../../native-chat/structured-agent-cli-source'
import { agentSessionProviderHandleChainHead } from '../../../../shared/agent-session-provider-handle'
import { structuredAgentRuntimeMetadata } from '../../structured-agent-runtime-metadata'
import type { AgentSessionSwitchDeadline } from '../../../../shared/agent-session-switch-execution'
export async function prepareStructuredSessionSwitch(
  params: z.infer<typeof SwitchToChatParams> | z.infer<typeof SwitchToTerminalParams>,
  ctx: RpcContext,
  sessionId: string,
  deadline: AgentSessionSwitchDeadline
) {
  await ensureStructuredHostInstalled(ctx)
  deadline.check()
  const execution = params.execution
  if (!execution) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  const create = 'create' in execution ? execution.create : undefined
  const host = create
    ? requireStructuredHost(ctx, create.agent)
    : requireStructuredSessionHost(ctx, sessionId)
  if (
    create &&
    (create.envelope.sessionId !== params.sessionId || !inPlaceSwitchEnabled(create.agent))
  ) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  const sourceEvidence =
    ctx.structuredAgentCliSourceEvidence ??
    (create?.resumeFrom?.cliSource
      ? captureStructuredAgentCliSource(
          () => ctx.runtime.getAgentProviderSessionRows(),
          create.resumeFrom.cliSource,
          (source) => ctx.runtime.getStructuredAgentCliSourceRoute(source)
        )
      : undefined)
  const createIdentity = create
    ? await ctx.runtime.resolveStructuredAgentSessionCreateIdentity({
        ...create,
        callerKey: structuredCallerFor(ctx).callerKey,
        structuredAgentCliSourceEvidence: sourceEvidence
      })
    : undefined
  const identity = createIdentity ?? host.deps.store.getRecord(sessionId)
  const providerSessionId =
    create?.resumeFrom?.providerSessionId ??
    (() => {
      const record = host.deps.store.getRecord(sessionId)
      const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)
      return (
        head && structuredAgentRuntimeMetadata(record!.provider)?.sessionHistory?.rowSessionId(head)
      )
    })()
  const conversation =
    identity && providerSessionId
      ? switchConversationIdentity(identity, providerSessionId)
      : undefined
  if (create && identity && providerSessionId) {
    sessionId = switchRetainedOwner(host, identity, providerSessionId) ?? sessionId
  }

  return {
    sessionId,
    host,
    execution,
    create,
    sourceEvidence,
    createIdentity,
    providerSessionId,
    conversation
  }
}

export function requireStructuredSwitchRecord(host: StructuredAgentSessionHost, sessionId: string) {
  const record = host.deps.store.getRecord(sessionId)
  if (!record || !inPlaceSwitchEnabled(record.provider)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  return record
}

export function captureStructuredSwitchWorkCheck(
  host: StructuredAgentSessionHost,
  sessionId: string,
  deadline: AgentSessionSwitchDeadline,
  direction: 'chat' | 'terminal'
): () => void {
  const workCurrent = host.captureSwitchWork(sessionId, deadline)
  return () => {
    deadline.check()
    if (!workCurrent()) {
      host.deps.logger.warn('switch destination was superseded by newer work', {
        scope: 'session-switch',
        sessionId,
        direction
      })
      throw agentSessionRefusalError('agent_session_operation_invalid', {
        reason: 'messagesUnsettled'
      })
    }
  }
}
