/**
 * Resolves a structured worker handle to the same authority facts a live PTY supplies.
 *
 * The registry holds the handle→session mapping for this process; the durable worker-terminal
 * resource row is what survives a restart, so a miss falls back to rehydrating from it. The
 * durable agent-session record is the liveness half: a session whose claim is conflicted or
 * released, or pinned to another execution host, is no longer this runtime's structured worker.
 */

import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { parseOrcaSessionAddress, type OrcaSessionId } from '../../shared/orca-session-address'
import type { RuntimeTerminalState } from '../../shared/runtime-types'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrchestrationDb } from './orchestration/db'
import { executingSessionId } from './orchestration/structured-session-lineage'
import {
  isStructuredWorkerHandle,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation,
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

/** The worker identity minted for a session, if that session is a structured worker. */
export function resolveStructuredWorkerIdentityForSession(
  sessionId: string,
  db: OrchestrationDb | null | undefined
): StructuredWorkerIdentity | null {
  const known = structuredWorkerIdentities.getBySessionId(sessionId)
  if (known) {
    return known
  }
  const row = db?.getWorkerTerminalResourceByProcessIncarnation?.(
    structuredWorkerProcessIncarnation(sessionId)
  )
  return row ? structuredWorkerIdentities.rehydrate(row) : null
}

/**
 * Whether this session was assigned a Dispatch as a structured worker. Such a session acts with its
 * worker handle, so one whose handle is gone must not act handle-less, as a chat would.
 */
export function isRecordedStructuredWorkerSession(
  sessionId: OrcaSessionId,
  db: OrchestrationDb
): boolean {
  return Boolean(
    db.db
      .prepare(
        `SELECT 1 FROM dispatch_contexts
         WHERE assignee_orca_session_id = ? AND process_incarnation = ? LIMIT 1`
      )
      .get(sessionId, structuredWorkerProcessIncarnation(sessionId))
  )
}

/**
 * The session running this worker now: the one minted for it, or that session's live `/clear`
 * successor, which carries on as the worker the way a terminal keeps its handle. The minted id
 * keys only the handle, pane and incarnation.
 */
export function structuredWorkerSessionId(
  identity: Pick<StructuredWorkerIdentity, 'sessionId'>
): string {
  return executingSessionId(identity.sessionId)
}

/** Identity plus the executing session's record, which still proves this runtime owns it. */
export function resolveStructuredWorkerAuthority(
  handle: string,
  db: OrchestrationDb | null | undefined
): StructuredWorkerAuthority | null {
  const identity = resolveStructuredWorkerIdentity(handle, db)
  if (!identity) {
    return null
  }
  const record = readStructuredAgentSessionRecord(structuredWorkerSessionId(identity))
  return record && structuredWorkerRecordIsCurrent(record) ? { identity, record } : null
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
    identity.agent ??
    readStructuredAgentSessionRecord(structuredWorkerSessionId(identity))?.provider ??
    'claude'
  )
}

export type StructuredWorkerObservation = {
  status: 'live' | 'unverifiable' | 'exited'
  reason?: string
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
 * The liveness of whatever structured session an assignee address names — a minted worker's handle
 * or a chat's `session:<id>` — observed on the session running it now; null when the address names
 * neither. worker-show and the fleet projection both read it, so they cannot disagree.
 */
export function observeStructuredAssignee(
  address: string,
  db: OrchestrationDb | null | undefined
): StructuredWorkerObservation | null {
  const chat = parseOrcaSessionAddress(address)
  if (chat) {
    return observeStructuredSession(executingSessionId(chat))
  }
  const worker = resolveStructuredWorkerIdentity(address, db)
  return worker ? observeStructuredWorker(worker) : null
}

/** A worker's liveness, observed on the session running it now (see `structuredWorkerSessionId`). */
export function observeStructuredWorker(
  identity: Pick<StructuredWorkerIdentity, 'sessionId'>
): StructuredWorkerObservation {
  return observeStructuredSession(structuredWorkerSessionId(identity))
}

/**
 * One session's own liveness. Only the session id is needed: the durable agent-session record is
 * the authority, and it outlives both the in-memory identity registry and this process. Callers
 * that hold nothing but a process incarnation therefore do not have to resolve a registry entry
 * first — after `forget` there is none, and gating on one answers `unverifiable` forever.
 */
export function observeStructuredSession(sessionId: string): StructuredWorkerObservation {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    // Reading the persisted record store here would force-install the host, which is itself a side
    // effect; not being able to look is not evidence the child is gone.
    return {
      status: 'unverifiable',
      reason: 'The structured agent-session host is not installed in this runtime generation.'
    }
  }
  const record = host.deps.store.getRecord(sessionId)
  if (!record) {
    return { status: 'unverifiable', reason: 'No durable record backs this structured session.' }
  }
  if (record.lease.claimStatus === 'released' && record.lease.deathEvidence) {
    return { status: 'exited' }
  }
  if (host.hasSession(sessionId) && record.lease.claimStatus === 'live') {
    return { status: 'live' }
  }
  return {
    status: 'unverifiable',
    reason: 'The session has no attached provider child in this runtime generation.'
  }
}
