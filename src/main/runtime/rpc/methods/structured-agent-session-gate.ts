// Who may see `agentSession.*` at all.
//
// Shared by every structured method file so one gate governs the whole surface: a client that does
// not advertise `agent-session.structured.v1` is told the surface does not exist rather than being
// handed a session it cannot render or drive — and, just as importantly, cannot make the host EXIST
// by calling into it, which is an observable side effect.

import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCaller } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import type { RpcContext } from '../core'
import { supportsStructuredAgentSessions } from './structured-agent-session-policy'

/**
 * In-process callers are the same build as the host, so they carry no negotiated
 * capability list; every remote client must say it can read structured sessions.
 */
export function supportsStructuredSessions(ctx: RpcContext): boolean {
  return supportsStructuredAgentSessions(ctx)
}

export function requireStructuredCapability(ctx: RpcContext): void {
  if (!supportsStructuredSessions(ctx)) {
    throw new Error('structured_agent_session_unsupported')
  }
}

export function requireStructuredHost(ctx: RpcContext): StructuredAgentSessionHost {
  requireStructuredCapability(ctx)
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('structured_agent_session_unsupported')
  }
  return host
}

/** Attach is the only way a session comes into being, so it is the only call
 *  that builds the host. Every other method addresses a session that must
 *  already be attached, and correctly reports absent when none is. */
export async function ensureStructuredHostInstalled(ctx: RpcContext): Promise<void> {
  // Gated first: a client that cannot read structured sessions must not be able
  // to make the host exist, which is an observable side effect of the surface.
  if (!supportsStructuredSessions(ctx) || getStructuredAgentSessionHost()) {
    return
  }
  await ctx.runtime.ensureStructuredAgentSessionHost()
}

/** Mirrors the existing agent-session host-authority derivation so one client
 *  gets one operation namespace across both surfaces. */
export function structuredCallerFor(ctx: RpcContext): StructuredAgentSessionCaller {
  return {
    callerKey: ctx.clientId?.trim() || `trusted-local:${ctx.clientKind ?? 'runtime'}`
  }
}
