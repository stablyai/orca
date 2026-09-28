// Who may see `agentSession.*` at all.
//
// Shared by every structured method file so one gate governs the whole surface: a client that does
// not advertise `agent-session.structured.v1` is told the surface does not exist rather than being
// handed the session journal or mutation surface.
//
// This gate no longer implies such a client cannot make the host exist: session-tab restore runs
// for old mobile clients while structured chat is enabled so they receive a fallback row, and that
// path constructs the host. `agentSession.*` stays refused either way, which is what this gate is for.

import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCaller } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import type { RpcContext } from '../core'
import {
  supportsStructuredAgentSessionCapability,
  supportsStructuredAgentSessions
} from './structured-agent-session-policy'

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

/**
 * WHICH GATE DOES A NEW `agentSession.*` METHOD GET?
 *
 * The host setting is admission control, and admission can be revoked while sessions are still
 * open. So the surface splits by what a method does to work in flight, not by how dangerous it
 * sounds:
 *
 *   - Starts, extends, retains or reads work -> `requireStructuredHost`. Revoked admission means
 *     no new turns, no new holds, no new reads. create, send, ensure, setOption,
 *     subscribe, hold, reveal, history, options and the status stream all live here.
 *   - Stops or retires work the caller already owns -> `requireStructuredCleanupHost`. close,
 *     cancel, unsubscribe and release live here.
 *
 * Cleanup keeps working after the setting is turned off because the alternative strands the user:
 * a session opened while the setting was on stays open, and refusing its close leaves a chat with
 * a live provider child that its own owner can no longer shut down. Stopping is never the thing
 * the policy exists to prevent.
 *
 * Cleanup is not an escape hatch. It still demands the negotiated wire capability, so a client
 * that never advertised the surface still cannot see it, and it never creates a host — it can
 * only retire what already exists.
 */
export function requireStructuredCleanupHost(ctx: RpcContext): StructuredAgentSessionHost {
  if (!supportsStructuredAgentSessionCapability(ctx)) {
    throw new Error('structured_agent_session_unsupported')
  }
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('structured_agent_session_unsupported')
  }
  return host
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
  ctx: RpcContext
): Promise<StructuredAgentSessionHost> {
  await ensureStructuredHostInstalled(ctx)
  return requireStructuredHost(ctx)
}

/** Mirrors the existing agent-session host-authority derivation so one client
 *  gets one operation namespace across both surfaces. */
export function structuredCallerFor(ctx: RpcContext): StructuredAgentSessionCaller {
  return {
    callerKey: ctx.clientId?.trim() || `trusted-local:${ctx.clientKind ?? 'runtime'}`
  }
}
