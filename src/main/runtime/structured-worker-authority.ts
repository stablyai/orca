/**
 * Resolves a structured worker handle to the same authority facts a live PTY supplies.
 *
 * The registry holds the handle→session mapping for this process; the durable worker-terminal
 * resource row is what survives a restart, so a miss falls back to rehydrating from it. The
 * durable agent-session record, the chat's tab and the orchestration's own resource row decide
 * custody: see `structured-worker-custody`.
 * Whether its provider process runs is a separate fact, `observeStructuredWorker`, and routing
 * never reads it — an agent at rest still receives mail, which starts it.
 *
 * Provider contexts can change while the worker's conversation and authority stay the same.
 */

import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { OrcaSessionId } from '../../shared/orca-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../shared/orchestration-session-caller-codes'
import type { RuntimeTerminalState } from '../../shared/runtime-types'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrchestrationDb } from './orchestration/db'
import { OrchestrationError } from './orchestration/orchestration-error'
import {
  readAgentSessionRecordStore,
  readStructuredAgentSessionRecord,
  locateStructuredSessionRecord,
  type LocatedStructuredSessionRecord,
  type StructuredSessionRecord
} from './orchestration/structured-session-records'
import {
  structuredSessionTabRetired,
  structuredWorkerAddressable
} from './structured-worker-custody'
import { AGENT_SESSION_FOUNDING_FENCE } from './agent-session-record-founding'
import { isAgentSessionHandleProvider } from '../../shared/agent-session-provider-handle'
import {
  isStructuredWorkerHandle,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation,
  type StructuredWorkerIdentity
} from './structured-worker-identity'

/** A worker this runtime holds, with its durable conversation record. */
export type StructuredWorkerAuthority = {
  identity: StructuredWorkerIdentity
  running: StructuredSessionRecord
}

/**
 * A worker resolved against custody: held; not held (released, or its chat retired); or its running
 * session cannot be verified, with the typed refusal an actor answers.
 */
export type StructuredWorkerHold =
  | ({ kind: 'held' } & StructuredWorkerAuthority)
  | ({ kind: 'not-held' } & StructuredWorkerAuthority)
  | {
      kind: 'unverifiable'
      identity: StructuredWorkerIdentity
      /** What could not be looked at, as an observation reports it. */
      reason: string
      refusal: OrchestrationError
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

/** The worker assigned to this conversation, rehydrated from its durable row after restart. */
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

/** The worker's conversation record and execution host. */
export function structuredWorkerSession(
  identity: Pick<StructuredWorkerIdentity, 'sessionId'>
): LocatedStructuredSessionRecord {
  return locateStructuredSessionRecord(readAgentSessionRecordStore(), identity.sessionId)
}

/** The worker's running session on this host, or the typed refusal an actor answers instead. */
function locateStructuredWorker(
  identity: Pick<StructuredWorkerIdentity, 'sessionId'>
): { running: StructuredSessionRecord } | { reason: string; refusal: OrchestrationError } {
  const located = structuredWorkerSession(identity)
  if (located.kind === 'here') {
    return { running: located }
  }
  return {
    reason:
      located.kind === 'other-host'
        ? 'The session running this worker is on another host.'
        : located.reason,
    refusal:
      located.kind === 'other-host'
        ? new OrchestrationError(
            CODES.hostBoundary,
            `Structured session ${located.sessionId} runs this worker on another host; act on it from that host. No effects were applied.`,
            { effectsApplied: false }
          )
        : new OrchestrationError(
            CODES.notLive,
            `The session running this structured worker cannot be verified: ${located.reason} No effects were applied.`,
            { effectsApplied: false }
          )
  }
}

/** The worker's running session on this host; throws the typed refusal before anything is done. */
export function requireRunningStructuredWorker(
  identity: Pick<StructuredWorkerIdentity, 'sessionId'>
): StructuredSessionRecord {
  const located = locateStructuredWorker(identity)
  if ('refusal' in located) {
    throw located.refusal
  }
  return located.running
}

/** Custody is independent of whether the conversation's provider is running. */
export function holdStructuredWorker(
  identity: StructuredWorkerIdentity,
  db: OrchestrationDb | null | undefined,
  row = db?.getWorkerTerminalResourceByHandle?.(identity.handle)
): StructuredWorkerHold {
  const located = locateStructuredWorker(identity)
  if ('refusal' in located) {
    return { kind: 'unverifiable', identity, reason: located.reason, refusal: located.refusal }
  }
  const addressable = structuredWorkerAddressable(db, located.running, row)
  if (addressable === null) {
    return {
      kind: 'unverifiable',
      identity,
      reason: 'The structured agent-session host is not installed in this runtime generation.',
      refusal: new OrchestrationError(
        CODES.notLive,
        'The structured agent-session host is not installed in this runtime generation. No effects were applied.',
        { effectsApplied: false }
      )
    }
  }
  return { kind: addressable ? 'held' : 'not-held', identity, running: located.running }
}

/** A worker this runtime owns and its orchestration has not released, with its running session. */
export function resolveStructuredWorkerAuthority(
  handle: string,
  db: OrchestrationDb | null | undefined
): StructuredWorkerAuthority | null {
  const identity = resolveStructuredWorkerIdentity(handle, db)
  const hold = identity ? holdStructuredWorker(identity, db) : null
  return hold?.kind === 'held' ? { identity: hold.identity, running: hold.running } : null
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
  if (identity.agent) {
    return identity.agent
  }
  // Workers are Claude or Codex sessions only: dispatch refuses any other agent.
  const running = structuredWorkerSession(identity)
  const provider = running.kind === 'unverifiable' ? undefined : running.record.provider
  return isAgentSessionHandleProvider(provider) ? provider : 'claude'
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
  const status = observeStructuredSession(sessionId).status
  return (
    status === 'exited' ||
    (status === 'unverifiable' &&
      readStructuredAgentSessionRecord(readAgentSessionRecordStore(), sessionId)?.lease
        .claimStatus === 'released')
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
 * A worker's liveness, observed on the session running it now. Only the session id is needed: the
 * durable agent-session records are the authority, and they outlive both the in-memory identity
 * registry and this process. Callers that hold nothing but a process incarnation therefore do not
 * have to resolve a registry entry first — after `forget` there is none, and gating on one answers
 * `unverifiable` forever.
 */
export function observeStructuredWorker(
  identity: Pick<StructuredWorkerIdentity, 'sessionId'>
): StructuredWorkerObservation {
  const located = locateStructuredWorker(identity)
  return 'running' in located
    ? observeStructuredSession(located.running.sessionId)
    : { status: 'unverifiable', reason: located.reason }
}

/**
 * Founded and never reserved: still at the founding fence, which every reservation moves, with no
 * owner, spawn, handoff or provider handle. A released reservation whose exit was never proven has
 * moved the fence, so it stays unverifiable.
 */
function structuredSessionNeverStarted(record: AgentSessionRecord): boolean {
  const { lease } = record
  return (
    lease.claimStatus === 'released' &&
    lease.runtimeFence === AGENT_SESSION_FOUNDING_FENCE &&
    // A fence floor marks a copy restored from backup, which may hide a reservation it lost.
    lease.minimumNextFence === undefined &&
    lease.ownerProcess === null &&
    lease.reservedSpawnToken === null &&
    lease.handoffStage === null &&
    record.providerHandleChain.length === 0
  )
}

/** One session's own liveness, for callers that act on that session rather than on a worker. */
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
  if (structuredSessionNeverStarted(record) && structuredSessionTabRetired(host, sessionId)) {
    // With its chat gone, an agent that never ran cannot acquire a process later.
    // Not `hasSession`: that says the conversation is open, which any history read makes it.
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
