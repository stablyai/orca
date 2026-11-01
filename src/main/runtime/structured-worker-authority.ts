/** Rehydrate worker identity from durable rows after restart; records, tab index and orchestration state decide custody.
 * Mail reaches agents at rest and starts them, so routing ignores process liveness. Resolve clear successors for every worker-level operation. */

import type { AgentSessionConversationView } from '../../shared/agent-session-conversation-view'
import { isOrcaSessionId, type OrcaSessionId } from '../../shared/orca-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../shared/orchestration-session-caller-codes'
import type { RuntimeTerminalState } from '../../shared/runtime-types'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { canonicalOrcaSessionId } from './orchestration/canonical-orca-session-id'
import type { OrchestrationDb } from './orchestration/db'
import { OrchestrationError } from './orchestration/orchestration-error'
import {
  readAgentSessionRecordStore,
  resolveLineageRunningSession,
  type LineageRunningSession,
  type RunningStructuredSession
} from './orchestration/structured-session-lineage'
import {
  structuredSessionTabRetired,
  structuredWorkerAddressable
} from './structured-worker-custody'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'
import { isStructuredWorkerHandle } from '../../shared/structured-worker-handle'
import {
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation,
  type StructuredWorkerIdentity
} from './structured-worker-identity'

/** A worker this runtime holds, with the session running it now (a `/clear` may have moved it). */
export type StructuredWorkerAuthority = {
  identity: StructuredWorkerIdentity
  running: RunningStructuredSession
}

/** Held, released/retired, or unverifiable with a typed refusal; custody is independent of process liveness. */
export type StructuredWorkerHold =
  | ({ kind: 'held' } & StructuredWorkerAuthority)
  | ({ kind: 'not-held' } & StructuredWorkerAuthority)
  | {
      kind: 'unverifiable'
      identity: StructuredWorkerIdentity
      reason: string
      refusal: OrchestrationError
    }

export function readStructuredAgentSessionRecord(
  sessionId: string
): AgentSessionConversationView | null {
  try {
    return getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId) ?? null
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

/** The worker a session runs for: minted for it, or one a `/clear` continued into it. */
export function resolveStructuredWorkerIdentityForSession(
  sessionId: string,
  db: OrchestrationDb | null | undefined
): StructuredWorkerIdentity | null {
  const exact = structuredWorkerIdentities.getBySessionId(sessionId)
  if (exact || !isOrcaSessionId(sessionId)) {
    return exact ?? resolveStructuredWorkerIdentityForRoot(sessionId, db)
  }
  return resolveStructuredWorkerIdentityForRoot(canonicalOrcaSessionId(sessionId), db)
}

/** The worker minted for a lineage root session, rehydrated from its durable row after a restart. */
export function resolveStructuredWorkerIdentityForRoot(
  rootSessionId: string,
  db: OrchestrationDb | null | undefined
): StructuredWorkerIdentity | null {
  const known = structuredWorkerIdentities.getBySessionId(rootSessionId)
  if (known) {
    return known
  }
  const row = db?.getWorkerTerminalResourceByProcessIncarnation?.(
    structuredWorkerProcessIncarnation(rootSessionId)
  )
  return row ? structuredWorkerIdentities.rehydrate(row) : null
}

/** Recorded workers must retain handle identity; a missing handle cannot turn one into an ordinary chat caller. */
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

/** The session running this worker now: the one minted for it, or its `/clear` successor. */
export function structuredWorkerSession(
  identity: Pick<StructuredWorkerIdentity, 'sessionId'>
): LineageRunningSession {
  return resolveLineageRunningSession(readAgentSessionRecordStore(), identity.sessionId)
}

/** The worker's running session on this host, or the typed refusal an actor answers instead. */
function locateStructuredWorker(
  identity: Pick<StructuredWorkerIdentity, 'sessionId'>
): { running: RunningStructuredSession } | { reason: string; refusal: OrchestrationError } {
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
): RunningStructuredSession {
  const located = locateStructuredWorker(identity)
  if ('refusal' in located) {
    throw located.refusal
  }
  return located.running
}

/** Custody judged on the session running the worker, never on the one it was minted under. */
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

/** Rehydrated rows omit provider; read the durable session record so restart archives cannot silently relabel Codex as Claude. */
export function structuredWorkerAgent(identity: StructuredWorkerIdentity): TuiAgent {
  if (identity.agent) {
    return identity.agent
  }
  const running = structuredWorkerSession(identity)
  const provider = running.kind === 'unverifiable' ? undefined : running.record.provider
  // An unreadable record or a provider this build doesn't know falls back to Claude.
  return isTuiAgent(provider) ? provider : 'claude'
}

export type StructuredWorkerObservation = {
  status: 'live' | 'unverifiable' | 'exited'
  reason?: string
}

/** Exited or released-but-unverifiable settles close; bookkeeping about a released process cannot refuse the user's tab close. */
export function structuredSessionCloseSettled(sessionId: string): boolean {
  const status = observeStructuredSession(sessionId).status
  return (
    status === 'exited' ||
    (status === 'unverifiable' &&
      readStructuredAgentSessionRecord(sessionId)?.ownerObservation.claimStatus === 'released')
  )
}

/** Unverifiable maps to unknown: loss of observation cannot prove a running child. */
export function structuredWorkerTerminalState(
  liveness: StructuredWorkerObservation['status']
): RuntimeTerminalState {
  return liveness === 'exited' ? 'exited' : liveness === 'live' ? 'running' : 'unknown'
}

/** Read the current session's durable liveness without requiring registry identity, which forget removes before some settlement probes. */
export function observeStructuredWorker(
  identity: Pick<StructuredWorkerIdentity, 'sessionId'>
): StructuredWorkerObservation {
  const located = locateStructuredWorker(identity)
  return 'running' in located
    ? observeStructuredSession(located.running.sessionId)
    : { status: 'unverifiable', reason: located.reason }
}

/** One session's own liveness, for callers that act on that session rather than on a worker. */
export function observeStructuredSession(sessionId: string): StructuredWorkerObservation {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    // Reading persisted storage would force-install the host; absent observation proves neither exit nor liveness.
    return {
      status: 'unverifiable',
      reason: 'The structured agent-session host is not installed in this runtime generation.'
    }
  }
  const record = host.deps.store.getConversation(sessionId)
  if (!record) {
    return { status: 'unverifiable', reason: 'No durable record backs this structured session.' }
  }
  if (record.ownerObservation.claimStatus === 'released' && record.ownerObservation.deathEvidence) {
    return { status: 'exited' }
  }
  if (record.neverStarted && structuredSessionTabRetired(host, sessionId)) {
    // A never-reserved session has no death evidence; with its tab retired nothing can start it.
    // hasSession only means an open conversation, which any history read creates.
    return { status: 'exited' }
  }
  if (host.hasSession(sessionId) && record.ownerObservation.claimStatus === 'live') {
    return { status: 'live' }
  }
  return {
    status: 'unverifiable',
    reason: 'The session has no attached provider child in this runtime generation.'
  }
}
