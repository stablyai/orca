// Who may see `agentSession.*` at all.
//
// Shared by every structured method file so one gate governs the whole surface: a client that does
// not advertise `agent-session.structured.v1` is told the surface does not exist rather than being
// handed the session journal or mutation surface.
//
// This gate does not imply such a client cannot make the host exist: session-tab restore runs for
// old mobile clients so they receive a fallback row, and that path constructs the host.
// `agentSession.*` stays refused either way, which is what this gate is for.

import { DSH_ACP_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCaller } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import type { RpcContext } from '../core'
import { structuredAgentSessionHostRefusal } from '../../structured-agent-session-host-refusal'
import {
  createSupportFollowsHostSetting,
  isStructuredNativeChatEnabled,
  supportsStructuredAgentSessions
} from './structured-agent-session-policy'

/**
 * In-process callers are the same build as the host, so they carry no negotiated
 * capability list; every remote client must say it can read structured sessions.
 */
export function supportsStructuredSessions(ctx: RpcContext): boolean {
  return supportsStructuredAgentSessions(ctx)
}

export function supportsDshStructuredSessions(ctx: RpcContext): boolean {
  return (
    ctx.clientKind === undefined ||
    ctx.clientCapabilities?.includes(DSH_ACP_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) === true
  )
}

export function requireDshStructuredCapability(ctx: RpcContext, agent: string | null): void {
  if (agent === 'dsh-acp' && !supportsDshStructuredSessions(ctx)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

export function requireStructuredCapability(ctx: RpcContext): void {
  if (!supportsStructuredSessions(ctx)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

/**
 * `agentSession.createSupport` alone also reads the host setting, for a client that leaves the
 * launch mode to the host; it gets the refusal it got before, which it reads as "open a terminal".
 */
export function requireStructuredCreateSupportAdmission(ctx: RpcContext): void {
  requireStructuredCapability(ctx)
  if (createSupportFollowsHostSetting(ctx) && !isStructuredNativeChatEnabled(ctx.runtime)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

export function requireStructuredHost(
  ctx: RpcContext,
  sessionId?: string
): StructuredAgentSessionHost {
  requireStructuredCapability(ctx)
  const host = requireHostOrRefusal()
  if (sessionId) {
    requireDshStructuredCapability(ctx, host.sessionAgent(sessionId))
  }
  return host
}

/**
 * The gate for methods that stop or retire work the caller already owns: close, cancel,
 * unsubscribe and release. It asks only what no caller can do without (the wire capability and a
 * host), never an admission condition: refusing a close strands a live provider child its own
 * owner can no longer shut down. It is `requireStructuredHost` today; keep it apart so a condition
 * added there for new work never reaches these.
 */
export function requireStructuredCleanupHost(ctx: RpcContext): StructuredAgentSessionHost {
  requireStructuredCapability(ctx)
  return requireHostOrRefusal()
}

/**
 * The host, or why there is none. A process whose journal would not open says so under every
 * getter, close included: nothing here can stop a child it never started.
 */
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

/** Builds the host for a call that may be the first this process sees. Every session is addressed
 *  by its durable record — a read opens a conversation at rest — so each call that reaches for one
 *  may meet a host nothing has built yet. */
export async function ensureStructuredHostInstalled(ctx: RpcContext): Promise<void> {
  // Gated first: a client that cannot read structured sessions must not be able
  // to make the host exist, which is an observable side effect of the surface.
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
  return requireStructuredHost(ctx, sessionId)
}

/** Mirrors the existing agent-session host-authority derivation so one client
 *  gets one operation namespace across both surfaces. */
export function structuredCallerFor(ctx: RpcContext): StructuredAgentSessionCaller {
  return {
    callerKey: ctx.clientId?.trim() || `trusted-local:${ctx.clientKind ?? 'runtime'}`
  }
}
