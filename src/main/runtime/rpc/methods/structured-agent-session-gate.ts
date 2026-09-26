// Who may see `agentSession.*` at all.
//
// Shared by every structured method file so one pair of gates governs the whole surface: a client
// that does not advertise `agent-session.structured.v1` is told the surface does not exist rather
// than being handed the session journal or mutation surface. (Session-tab restore still runs for
// old mobile clients so they get a fallback row, and that can construct the host; `agentSession.*`
// stays refused to them either way.)

import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCaller } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import type { RpcContext } from '../core'
import {
  canCreateStructuredAgentSessions,
  canServeStructuredAgentSessions
} from './structured-agent-session-policy'

/**
 * WHICH GATE DOES A NEW `agentSession.*` METHOD GET?
 *
 *   - Brings a NEW session into being -> `requireStructuredCreatePermission` first. createSupport,
 *     create and ensure (which attaches a client-supplied location) live here; the host's Chat UI
 *     setting is asked on top of the capability.
 *   - Everything else reads, drives, stops or closes a session that already exists, and asks only
 *     the capability. Turning Chat UI off changes how new launches open, never whether an open chat
 *     can still be read, answered, resumed or closed.
 */
export function requireStructuredCapability(ctx: RpcContext): void {
  if (!canServeStructuredAgentSessions(ctx)) {
    throw new Error('structured_agent_session_unsupported')
  }
}

export function requireStructuredCreatePermission(ctx: RpcContext): void {
  if (!canCreateStructuredAgentSessions(ctx)) {
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

/** Builds the host for the calls that address a session by durable record rather than by live
 *  state: attach, which is the only way a session comes into being, plus hold and reveal, which
 *  each reach for a record on disk this process may not have opened yet. Every other method
 *  addresses a session that must already be attached, and correctly reports absent when none is. */
export async function ensureStructuredHostInstalled(ctx: RpcContext): Promise<void> {
  // Gated first: a client that cannot read structured sessions must not be able
  // to make the host exist, which is an observable side effect of the surface.
  if (!canServeStructuredAgentSessions(ctx)) {
    return
  }
  if (getStructuredAgentSessionHost()) {
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
