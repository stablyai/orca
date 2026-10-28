// Require structured.v1 across every agentSession method before exposing journals or mutations.
// Legacy tab restore may still install the host for fallback rows; that never admits agentSession calls.

import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCaller } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import type { RpcContext } from '../core'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
import { structuredAgentSessionHostRefusal } from '../../structured-agent-session-host-refusal'
import {
  createSupportFollowsHostSetting,
  clientReadsStructuredSessionAgent,
  isStructuredNativeChatDefaultFor,
  supportsStructuredAgentSessions
} from './structured-agent-session-policy'

/** In-process callers share the host build; remote callers must advertise structured-session support. */
export function supportsStructuredSessions(ctx: RpcContext): boolean {
  return supportsStructuredAgentSessions(ctx)
}

export function requireStructuredCapability(ctx: RpcContext): void {
  if (!supportsStructuredSessions(ctx)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

export function requireStructuredAgentAudience(ctx: RpcContext, agent: string): void {
  requireStructuredCapability(ctx)
  if (!clientReadsStructuredSessionAgent(ctx, agent)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

/** Only createSupport consults launch preference for legacy mode pickers, preserving their terminal-fallback refusal. */
export function requireStructuredCreateSupportAdmission(ctx: RpcContext, agent?: string): void {
  requireStructuredAgentAudience(ctx, agent ?? '')
  if (
    createSupportFollowsHostSetting(ctx) &&
    !isStructuredNativeChatDefaultFor(ctx.runtime, agent ?? '')
  ) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

export function requireStructuredHost(ctx: RpcContext, agent?: string): StructuredAgentSessionHost {
  requireStructuredAgentAudience(ctx, agent ?? '')
  return requireHostOrRefusal()
}

export function requireStructuredSessionHost(
  ctx: RpcContext,
  sessionId: string
): StructuredAgentSessionHost {
  const host = requireStructuredHost(ctx)
  requireStructuredAgentAudience(ctx, host.sessionAgent(sessionId) ?? '')
  return host
}

/** Close/cancel/unsubscribe/release check wire capability and host only; new-work admission conditions must never strand already-owned children. */
export function requireStructuredCleanupHost(ctx: RpcContext): StructuredAgentSessionHost {
  requireStructuredCapability(ctx)
  return requireHostOrRefusal()
}

/** Return the host or its failure, including journal-open refusal; this process cannot stop children it never started. */
function requireHostOrRefusal(): StructuredAgentSessionHost {
  const host = getStructuredAgentSessionHost()
  if (host) {
    return host
  }
  throw (
    structuredAgentSessionHostRefusal() ??
    agentSessionRefusalError('structured_agent_session_unsupported', { reason: 'hostDisabled' })
  )
}

/** Build lazily before durable-record reads, including chats at rest after restart. */
export async function ensureStructuredHostInstalled(
  ctx: RpcContext,
  agent?: string
): Promise<void> {
  if (agent) {
    requireStructuredAgentAudience(ctx, agent)
  }
  // Check capability before observable host installation.
  if (!supportsStructuredSessions(ctx)) {
    return
  }
  if (getStructuredAgentSessionHost()) {
    return
  }
  await ctx.runtime.ensureStructuredAgentSessionHost()
}

/** The host for a read, built first when this process has none: the read RPCs share this one. */
export async function requireInstalledStructuredHost(
  ctx: RpcContext,
  sessionId?: string
): Promise<StructuredAgentSessionHost> {
  await ensureStructuredHostInstalled(ctx)
  return sessionId ? requireStructuredSessionHost(ctx, sessionId) : requireStructuredHost(ctx)
}

/** Persist/share proven paired device id, never clientId bearer credentials (for example, who answered a prompt). */
export function structuredCallerFor(ctx: RpcContext): StructuredAgentSessionCaller {
  return {
    callerKey:
      ctx.caller?.kind === 'paired-device'
        ? rpcCallerOperationKey(ctx.caller)
        : ctx.clientId?.trim() || `trusted-local:${ctx.clientKind ?? 'runtime'}`
  }
}
