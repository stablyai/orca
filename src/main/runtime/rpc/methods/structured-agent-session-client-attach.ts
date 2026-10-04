import type { z } from 'zod'
import type { RpcContext } from '../core'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import type { AgentSessionAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import type { AttachParams } from './structured-agent-session-schemas'
import {
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireDshStructuredCapability,
  requireStructuredHost as requireHost,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'

// Client-provided locations require the executing host's admission check.
export async function resolveClientSuppliedAttach(
  params: z.infer<typeof AttachParams>,
  ctx: RpcContext
) {
  await ensureHostInstalled(ctx)
  requireDshStructuredCapability(ctx, params.provider)
  if (params.provider === 'dsh-acp' || (params.agent !== 'claude' && params.agent !== 'codex')) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  const host = requireHost(ctx, params.envelope.sessionId)
  if (!host.supportsCreate(params.location, params.agent)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  const attachParams: AgentSessionAttachParams = {
    ...params,
    provider: params.provider,
    agent: params.agent
  }
  return { host, attachParams }
}

export async function attachClientSuppliedLocation(
  params: z.infer<typeof AttachParams>,
  ctx: RpcContext
): Promise<unknown> {
  const { host, attachParams } = await resolveClientSuppliedAttach(params, ctx)
  return host.attach(callerFor(ctx), attachParams)
}
