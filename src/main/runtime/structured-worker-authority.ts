/**
 * Resolves a structured worker handle to the same authority facts a live PTY supplies.
 *
 * The registry holds the handle→session mapping for this process; the durable worker-terminal
 * resource row is what survives a restart, so a miss falls back to rehydrating from it. The
 * durable agent-session record and the chat's tab are the ownership half: see `structuredWorkerOwned`.
 * Whether its provider process runs is a separate fact, `observeStructuredWorker`, and routing
 * never reads it — an agent at rest still receives mail, which starts it.
 */

import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { RuntimeTerminalState } from '../../shared/runtime-types'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrchestrationDb } from './orchestration/db'
import {
  isStructuredWorkerHandle,
  structuredWorkerIdentities,
  structuredWorkerRecordIsCurrent,
  type StructuredWorkerIdentity
} from './structured-worker-identity'

export type StructuredWorkerAuthority = {
  identity: StructuredWorkerIdentity
  record: AgentSessionRecord
}

export function readStructuredAgentSessionRecord(sessionId: string): AgentSessionRecord | null {
  try {
    return getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId) ?? null
  } catch {
    return null
  }
}

/** Registry entry for a handle, rehydrated from the durable row when this process restarted. */
export function resolveStructuredWorkerIdentity(
  handle: string,
  db: OrchestrationDb | null | undefined
): StructuredWorkerIdentity | null {
  if (!isStructuredWorkerHandle(handle)) {
    return null
  }
  const known = structuredWorkerIdentities.get(handle)
  if (known) {
    return known
  }
  const row = db?.getWorkerTerminalResourceByHandle?.(handle)
  return row ? structuredWorkerIdentities.rehydrate(row) : null
}

/**
 * Whether this runtime still owns the worker's session: routing, addressing and authority ask
 * this, never whether its process runs. Null when the host is not installed, because reading the
 * record store would install it — not being able to look is not an answer.
 */
export function structuredWorkerOwned(sessionId: string): boolean | null {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  const record = readStructuredAgentSessionRecord(sessionId)
  return structuredWorkerRecordIsCurrent(
    record,
    record?.lease.claimStatus === 'released' && structuredWorkerTabListed(host, sessionId)
  )
}

/** Retirement is the tab index: every path that ends a chat for good hides its tab. */
function structuredWorkerTabListed(
  host: NonNullable<ReturnType<typeof getStructuredAgentSessionHost>>,
  sessionId: string
): boolean {
  try {
    return host.getPersistedVisibleSessionTabIndex?.().sessionIds.includes(sessionId) ?? false
  } catch {
    return false
  }
}

/** Identity plus a record that still proves this runtime owns the session. */
export function resolveStructuredWorkerAuthority(
  handle: string,
  db: OrchestrationDb | null | undefined
): StructuredWorkerAuthority | null {
  const identity = resolveStructuredWorkerIdentity(handle, db)
  if (!identity) {
    return null
  }
  const record = readStructuredAgentSessionRecord(identity.sessionId)
  return record && structuredWorkerOwned(identity.sessionId) ? { identity, record } : null
}

/**
 * Which provider this worker actually talks to.
 *
 * The registry carries it only for a session THIS process started; a rehydrated entry has null,
 * because the durable worker-terminal row does not record a provider. The durable agent-session
 * record does, and it is the only source that survives a restart — defaulting instead would
 * relabel every restarted Codex worker as Claude, permanently, because the startup release
 * reconciler stamps the frozen journal archive with whatever it is told here.
 */
export function structuredWorkerAgent(identity: StructuredWorkerIdentity): 'claude' | 'codex' {
  return (
    identity.agent ?? readStructuredAgentSessionRecord(identity.sessionId)?.provider ?? 'claude'
  )
}

export type StructuredWorkerObservation = {
  status: 'live' | 'unverifiable' | 'exited'
  reason?: string
}

/**
 * Whether a close left nothing running: `exited`, or `unverifiable` on a released lease — a release
 * whose stop could not be proven, which sent no signal and is left as it is. Closing a chat is the
 * user's action, and bookkeeping about a process already released must not refuse it.
 */
export function structuredSessionCloseSettled(sessionId: string): boolean {
  const status = observeStructuredWorker({ sessionId }).status
  return (
    status === 'exited' ||
    (status === 'unverifiable' &&
      readStructuredAgentSessionRecord(sessionId)?.lease.claimStatus === 'released')
  )
}

/**
 * The observation as the terminal state every read result reports.
 *
 * `unverifiable` must never render as `running`: losing sight of the structured host is not
 * evidence its child is alive, and the PTY sibling maps the same verdict to `unknown`.
 */
export function structuredWorkerTerminalState(
  liveness: StructuredWorkerObservation['status']
): RuntimeTerminalState {
  return liveness === 'exited' ? 'exited' : liveness === 'live' ? 'running' : 'unknown'
}

/**
 * Only the session id is needed: the durable agent-session record is the authority, and it
 * outlives both the in-memory identity registry and this process. Callers that hold nothing but a
 * process incarnation therefore do not have to resolve a registry entry first — after `forget`
 * there is none, and gating on one answers `unverifiable` forever.
 */
export function observeStructuredWorker(
  identity: Pick<StructuredWorkerIdentity, 'sessionId'>
): StructuredWorkerObservation {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    // Reading the persisted record store here would force-install the host, which is itself a side
    // effect; not being able to look is not evidence the child is gone.
    return {
      status: 'unverifiable',
      reason: 'The structured agent-session host is not installed in this runtime generation.'
    }
  }
  const record = host.deps.store.getRecord(identity.sessionId)
  if (!record) {
    return { status: 'unverifiable', reason: 'No durable record backs this structured session.' }
  }
  if (record.lease.claimStatus === 'released' && record.lease.deathEvidence) {
    return { status: 'exited' }
  }
  if (host.hasSession(identity.sessionId) && record.lease.claimStatus === 'live') {
    return { status: 'live' }
  }
  return {
    status: 'unverifiable',
    reason: 'The session has no attached provider child in this runtime generation.'
  }
}
