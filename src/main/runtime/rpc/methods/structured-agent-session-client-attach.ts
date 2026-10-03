import type { z } from 'zod'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import type { AgentSessionAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import type { RpcContext } from '../core'
import type { AttachParams } from './structured-agent-session-schemas'
import {
  requireCursorStructuredCapability,
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireStructuredHost as requireHost,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'

/**
 * The attach-shaped entries take the location from the client instead of resolving it from a
 * worktree, so they never reach the worktree-resolving create-support check. Ask the executing
 * host the same question directly: the answer includes host-measured facts the client cannot see
 * or forge, such as whether this machine can read a provider child's process start time.
 */
export async function resolveClientSuppliedAttach(
  params: z.infer<typeof AttachParams>,
  ctx: RpcContext
) {
  requireCursorStructuredCapability(ctx, params.agent)
  requireCursorStructuredCapability(ctx, params.provider)
  if (
    (params.agent === 'cursor' || params.provider === 'cursor') &&
    params.agent !== params.provider
  ) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  if (!isAgentSessionHandleProvider(params.agent)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  await ensureHostInstalled(ctx)
  const host = requireHost(ctx)
  if (!host.supportsCreate(params.location, params.agent)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  const { agent: _attachAgent, provider: _attachProvider, ...attachWithoutAgent } = params
  const attachParams = {
    ...attachWithoutAgent,
    provider: params.provider,
    agent: params.agent
  } satisfies AgentSessionAttachParams
  return { host, attachParams }
}

export async function attachClientSuppliedLocation(
  params: z.infer<typeof AttachParams>,
  ctx: RpcContext
): Promise<unknown> {
  const { host, attachParams } = await resolveClientSuppliedAttach(params, ctx)
  return host.attach(callerFor(ctx), attachParams)
}
