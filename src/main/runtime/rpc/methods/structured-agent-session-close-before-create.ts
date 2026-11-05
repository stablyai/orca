// Main remembers close-before-create because its layout-owning window has no local cancel tombstone; refuse pending creates or close them on arrival.

import {
  type AgentSessionWireRefusal,
  refuseUnclassified
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RpcContext } from '../core'
import {
  type StructuredSessionSurface,
  closeCapturedStructuredSession
} from '../../agent-session/structured-agent-session-close'

// Per-launch ids prevent cross-create matches; cap entries whose create never arrives.
const MAX_CLOSED_BEFORE_CREATE = 256
const closedBeforeCreate = new Set<string>()
const createsUnderWay = new Map<string, number>()

/** `hasRecord`: a create already committed, so this is an ordinary close unless one is under way. */
export function noteStructuredAgentSessionClose(sessionId: string, hasRecord: boolean): void {
  if (hasRecord && !createsUnderWay.has(sessionId)) {
    return
  }
  closedBeforeCreate.add(sessionId)
  for (const oldest of closedBeforeCreate) {
    if (closedBeforeCreate.size <= MAX_CLOSED_BEFORE_CREATE) {
      break
    }
    closedBeforeCreate.delete(oldest)
  }
}

export function structuredAgentSessionClosedBeforeCreate(sessionId: string): boolean {
  return closedBeforeCreate.has(sessionId)
}

export function structuredAgentSessionClosedBeforeCreateRefusal(): AgentSessionWireRefusal {
  return refuseUnclassified(
    'agent_session_operation_invalid',
    'The chat was closed before it was created.'
  )
}

/** Wraps `agentSession.create`: a close that arrived while it ran closes the chat it made. */
export function refusingStructuredAgentSessionCreatesClosedFirst<
  Params extends { envelope: { sessionId: string } },
  Result extends { ok: boolean }
>(
  create: (
    params: Params,
    ctx: RpcContext,
    capture?: (surface: StructuredSessionSurface) => void
  ) => Promise<Result>
): (
  params: Params,
  ctx: RpcContext
) => Promise<Result | { ok: false; refusal: AgentSessionWireRefusal }> {
  return async (params, ctx) => {
    const { sessionId } = params.envelope
    createsUnderWay.set(sessionId, (createsUnderWay.get(sessionId) ?? 0) + 1)
    let closedFirst = false
    let surface: StructuredSessionSurface | null = null
    try {
      const result = await create(params, ctx, (actual) => {
        surface = actual
      })
      closedFirst = closedBeforeCreate.has(sessionId)
      // The record stays on disk, as for any closed chat; the refusal only says the launch is off.
      return closedFirst
        ? { ok: false, refusal: structuredAgentSessionClosedBeforeCreateRefusal() }
        : result
    } catch (error) {
      closedFirst = closedBeforeCreate.has(sessionId)
      throw error
    } finally {
      const remaining = (createsUnderWay.get(sessionId) ?? 1) - 1
      if (remaining > 0) {
        createsUnderWay.set(sessionId, remaining)
      } else {
        createsUnderWay.delete(sessionId)
      }
      // Any answer, a refusal or a throw past commit included, may have left the chat made.
      if (closedFirst) {
        // Logged, not thrown: the client must still hear that the chat was closed first.
        await closeCreatedChat(ctx, sessionId, surface).catch((error: unknown) =>
          console.warn(
            '[structured-agent-session] closing a chat closed before create failed',
            error
          )
        )
      }
    }
  }
}

/** Cancellation owns only the actual surface published by this create. */
async function closeCreatedChat(
  ctx: RpcContext,
  sessionId: string,
  surface: StructuredSessionSurface | null
): Promise<void> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return
  }
  await closeCapturedStructuredSession(host, sessionId, 'user-close', surface, ctx.runtime)
}

export function resetStructuredAgentSessionClosesBeforeCreateForTests(): void {
  closedBeforeCreate.clear()
  createsUnderWay.clear()
}
