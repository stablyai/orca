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
import type { StructuredAgentSessionLaunchOrigin } from '../../../../shared/structured-agent-session-create'
import type { StructuredAgentSessionLaunchAuthority } from '../../../../shared/structured-agent-session-create'
import {
  structuredAgentSessionCreateWorktreeTarget,
  type StructuredAgentSessionCreateWorktreeTarget
} from '../../structured-agent-session-create-worktree-target'
import {
  structuredWorkItemStartCallerAuthority,
  supportsStructuredAgentSessionCapability,
  supportsStructuredAgentSessions,
  supportsWorkItemStartStructuredSessionCreate
} from './structured-agent-session-policy'

/**
 * In-process callers are the same build as the host, so they carry no negotiated
 * capability list; every remote client must say it can read structured sessions.
 */
export function supportsStructuredSessions(ctx: RpcContext): boolean {
  return supportsStructuredAgentSessions(ctx)
}

export function requireStructuredCapability(ctx: RpcContext): void {
  if (!supportsStructuredAgentSessionCapability(ctx)) {
    throw new Error('structured_agent_session_unsupported')
  }
}

export function canAccessWorkItemStartStructuredSession(
  ctx: Pick<
    RpcContext,
    'clientCapabilities' | 'clientKind' | 'localDesktopAuthority' | 'pairedDeviceId'
  >,
  sessionId: string
): boolean {
  const callerAuthority = structuredWorkItemStartCallerAuthority(ctx)
  if (!callerAuthority) {
    return false
  }
  const record = getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId)
  if (record?.launchOrigin !== 'work-item-start') {
    return false
  }
  if (callerAuthority.kind === 'local-desktop') {
    return true
  }
  return (
    record.launchAuthority?.kind === 'paired-device' &&
    record.launchAuthority.deviceId === callerAuthority.deviceId
  )
}

export async function resolveWorkItemStartStructuredCreateAuthority(
  ctx: RpcContext,
  worktree: string
): Promise<{
  launchAuthority: StructuredAgentSessionLaunchAuthority
  worktreeTarget: StructuredAgentSessionCreateWorktreeTarget
} | null> {
  const launchAuthority = structuredWorkItemStartCallerAuthority(ctx)
  if (!launchAuthority) {
    return null
  }
  const workspace = await ctx.runtime.showManagedWorktree(worktree)
  const worktreeTarget = structuredAgentSessionCreateWorktreeTarget(workspace)
  if (
    launchAuthority.kind === 'paired-device' &&
    worktreeTarget.creatorDeviceId !== launchAuthority.deviceId
  ) {
    return null
  }
  return { launchAuthority, worktreeTarget }
}

export function isWorkItemStartStructuredSession(
  host: StructuredAgentSessionHost | null,
  sessionId: string
): boolean {
  return host?.deps.store.getRecord(sessionId)?.launchOrigin === 'work-item-start'
}

export function requireStructuredHost(
  ctx: RpcContext,
  sessionId?: string
): StructuredAgentSessionHost {
  requireStructuredCapability(ctx)
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('structured_agent_session_unsupported')
  }
  if (
    sessionId && isWorkItemStartStructuredSession(host, sessionId)
      ? !canAccessWorkItemStartStructuredSession(ctx, sessionId)
      : !supportsStructuredSessions(ctx)
  ) {
    throw new Error('structured_agent_session_unsupported')
  }
  return host
}

export function requireStructuredCreateHost(
  ctx: RpcContext,
  launchOrigin: StructuredAgentSessionLaunchOrigin | undefined,
  sessionId?: string
): StructuredAgentSessionHost {
  requireStructuredCapability(ctx)
  const admitted = launchOrigin
    ? supportsWorkItemStartStructuredSessionCreate(ctx, launchOrigin) ||
      (sessionId !== undefined && canAccessWorkItemStartStructuredSession(ctx, sessionId))
    : supportsStructuredSessions(ctx)
  if (!admitted) {
    throw new Error('structured_agent_session_unsupported')
  }
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('structured_agent_session_unsupported')
  }
  return host
}

export function requireWorkItemStartStatusHost(ctx: RpcContext): StructuredAgentSessionHost {
  requireStructuredCapability(ctx)
  const host = getStructuredAgentSessionHost()
  if (
    !structuredWorkItemStartCallerAuthority(ctx) ||
    !host ||
    (!supportsStructuredSessions(ctx) &&
      !host.deps.store
        .listRecords()
        .some((record) => canAccessWorkItemStartStructuredSession(ctx, record.sessionId)))
  ) {
    throw new Error('structured_agent_session_unsupported')
  }
  return host
}

/**
 * WHICH GATE DOES A NEW `agentSession.*` METHOD GET?
 *
 * Global admission can be revoked while sessions are still open. A work-item-start session keeps
 * its narrower server-derived admission in its durable record. Cleanup remains available either
 * way, so the surface splits by what a method does to work in flight:
 *
 *   - Starts, extends, retains or reads work -> `requireStructuredHost`. Global sessions follow
 *     global admission; work-item-start sessions require their authoritative launch route.
 *   - Stops or retires work the caller already owns -> `requireStructuredCleanupHost`. close,
 *     cancel, unsubscribe and release live here.
 *
 * Cleanup keeps working after the setting is turned off because the alternative strands the user.
 * A scoped work-item session still requires its authoritative launch route; global sessions
 * preserve the existing cleanup behavior for capable clients.
 *
 * Cleanup is not an escape hatch. It still demands the negotiated wire capability, so a client
 * that never advertised the surface still cannot see it, and it never creates a host — it can
 * only retire what already exists.
 */
export function requireStructuredCleanupHost(
  ctx: RpcContext,
  sessionId: string
): StructuredAgentSessionHost {
  if (!supportsStructuredAgentSessionCapability(ctx)) {
    throw new Error('structured_agent_session_unsupported')
  }
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('structured_agent_session_unsupported')
  }
  if (
    isWorkItemStartStructuredSession(host, sessionId) &&
    !canAccessWorkItemStartStructuredSession(ctx, sessionId)
  ) {
    throw new Error('structured_agent_session_unsupported')
  }
  return host
}

/** Builds the host for the calls that address a session by durable record rather than by live
 *  state: attach, which is the only way a session comes into being, plus hold and reveal, which
 *  each reach for a record on disk this process may not have opened yet. Every other method
 *  addresses a session that must already be attached, and correctly reports absent when none is. */
export async function ensureStructuredHostInstalled(
  ctx: RpcContext,
  scoped?: { sessionId?: string; launchOrigin?: StructuredAgentSessionLaunchOrigin }
): Promise<void> {
  // Gated first: a client that cannot read structured sessions must not be able
  // to make the host exist, which is an observable side effect of the surface.
  const mayInstallForScopedSession =
    structuredWorkItemStartCallerAuthority(ctx) !== null &&
    (Boolean(scoped?.sessionId) ||
      supportsWorkItemStartStructuredSessionCreate(ctx, scoped?.launchOrigin))
  if (!supportsStructuredSessions(ctx) && !mayInstallForScopedSession) {
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
