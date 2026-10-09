import type { z } from 'zod'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { agentSessionFingerprintConflict } from '../../../../shared/agent-session-mutation-envelope'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import type { RpcContext } from '../core'
import {
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireStructuredHost as requireHost,
  requireStructuredAgentAudience,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import type { AgentSessionAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import type { AttachParams, CreateParams } from './structured-agent-session-schemas'
import {
  commitStructuredAgentSessionCreate,
  prepareStructuredAgentSessionCreateForWorktree,
  structuredAgentSessionCreateIntentFingerprint
} from './structured-agent-session-create'
import { resolveUncommittedStructuredCreate } from './structured-agent-session-precommit-refusal'

/**
 * The attach-shaped entries take the location from the client instead of resolving it from a
 * worktree, so they never reach the worktree-resolving create-support check. Ask the executing
 * host the same question directly: only it knows which agents and locations it runs, and a client
 * cannot forge that answer.
 */
async function resolveClientSuppliedAttach(params: z.infer<typeof AttachParams>, ctx: RpcContext) {
  await ensureHostInstalled(ctx, params.agent)
  const host = requireHost(ctx, params.agent)
  if (!host.supportsCreate(params.location, params.agent)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  const attachParams: AgentSessionAttachParams = params
  return { host, attachParams }
}

export async function attachClientSuppliedLocation(
  params: z.infer<typeof AttachParams>,
  ctx: RpcContext
): Promise<unknown> {
  const { host, attachParams } = await resolveClientSuppliedAttach(params, ctx)
  return host.attach(callerFor(ctx), attachParams)
}

export async function handleStructuredAgentSessionCreate(
  params: z.infer<typeof CreateParams>,
  ctx: RpcContext
) {
  requireStructuredAgentAudience(ctx, params.agent)
  if (params.envelope.expectedRuntimeFence !== null) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  // Everything up to `attach` is pre-commit, and answers with a refusal rather than a throw so
  // a client can tell "nothing was created" from "the outcome is unknown".
  const prepared = await resolveUncommittedStructuredCreate(async () => {
    if ('worktree' in params) {
      const conflict = agentSessionFingerprintConflict(
        params.envelope,
        structuredAgentSessionCreateIntentFingerprint(params)
      )
      if (conflict) {
        return { refusal: conflict }
      }
      return prepareStructuredAgentSessionCreateForWorktree({
        runtime: ctx.runtime,
        ensureHost: async () => {
          await ensureHostInstalled(ctx)
          return requireHost(ctx)
        },
        envelope: params.envelope,
        worktree: params.worktree,
        agent: params.agent,
        caller: callerFor(ctx),
        ...(params.resumeFrom ? { resumeFrom: params.resumeFrom } : {}),
        ...(params.tabId ? { tabId: params.tabId } : {}),
        ...(params.options ? { options: params.options } : {}),
        ...(params.firstMessage ? { firstMessage: params.firstMessage } : {}),
        atRest: Boolean(
          params.firstMessage ||
          ctx.clientCapabilities?.includes(AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY)
        )
      })
    }
    const { host, attachParams } = await resolveClientSuppliedAttach(params, ctx)
    return { host, attachParams, tab: null }
  })
  if ('refusal' in prepared) {
    return { ok: false, refusal: prepared.refusal }
  }
  return commitStructuredAgentSessionCreate({
    runtime: ctx.runtime,
    caller: callerFor(ctx),
    prepared,
    activate: true
  })
}
