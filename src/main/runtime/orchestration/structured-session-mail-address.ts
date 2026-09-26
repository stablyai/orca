/**
 * A structured agent session as a mail address: `session:<id>`, the Orca-minted id every agent is
 * told is its public address. Recipient routing and pointer delivery both read these rules off the
 * durable session record, so the two can never disagree about which sessions mail can reach.
 *
 * The address names a conversation, not one session of it: any session of a `/clear` lineage names
 * the lineage root's address (`canonicalOrcaSessionId`), and mail reaches the lineage's live session.
 *
 * A released lease does not end a session. The host evicts a chat nobody is looking at 15s after
 * its last turn and hands its lease back, and mail must wake it again (resume on demand). For mail,
 * a conversation has ended only when its chat was closed.
 */

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isOrcaSessionId, type OrcaSessionId } from '../../../shared/orca-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../shared/orchestration-session-caller-codes'
import { structuredWorkerHostScope } from '../structured-worker-identity'
import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import { resolveOrcaSessionParty, type OrchestrationSessionParty } from './orchestration-party'
import { lineageLiveSession, type AgentSessionRecordReader } from './structured-session-lineage'

export type OrcaAgentSessionLookup =
  | { kind: 'found'; record: AgentSessionRecord }
  /** The id is a provider's own session id, which rotates on `/clear`; this names the Orca id. */
  | { kind: 'provider-id'; orcaSessionId: string }
  | { kind: 'unknown' }

export function lookupOrcaAgentSession(
  store: AgentSessionRecordReader,
  id: string
): OrcaAgentSessionLookup {
  const record = store.getRecord(id)
  if (record) {
    return { kind: 'found', record }
  }
  const owner = store
    .listRecords()
    .find((candidate) =>
      candidate.providerHandleChain.some(({ handle }) =>
        handle.provider === 'claude' ? handle.sessionId === id : handle.threadId === id
      )
    )
  return owner ? { kind: 'provider-id', orcaSessionId: owner.sessionId } : { kind: 'unknown' }
}

export type StructuredSessionMailReach =
  /** `session` is the conversation's live session, the one its mail reaches now. */
  | { kind: 'reachable'; session: AgentSessionRecord }
  | { kind: 'other-host' }
  | { kind: 'ended'; reason: 'closed' | 'worker-identity-lost' | 'continuation-missing' }

/** Whether mail to `record`'s conversation can reach the session that runs it now. */
export function structuredSessionMailReach(
  store: AgentSessionRecordReader,
  record: AgentSessionRecord,
  db: OrchestrationDb | null | undefined
): StructuredSessionMailReach {
  const live = lineageLiveSession(store, record.sessionId)
  if (!live) {
    return { kind: 'ended', reason: 'continuation-missing' }
  }
  if (!structuredWorkerHostScope(live.location)) {
    return { kind: 'other-host' }
  }
  if (isOrcaSessionId(live.sessionId) && !addressableSessionParty(live.sessionId, db)) {
    // Why: it can no longer act (the caller resolver refuses it), so mail to it could never be read.
    return { kind: 'ended', reason: 'worker-identity-lost' }
  }
  const visible = store.getVisibleSessionTabIndex?.()
  if (visible?.present && !visible.sessionIds.includes(live.sessionId)) {
    // Why: reviving a chat the user closed would run turns nobody can see; its mail waits instead.
    return { kind: 'ended', reason: 'closed' }
  }
  return { kind: 'reachable', session: live }
}

/**
 * The party a session resolves to, or null for a worker whose identity this host lost: the party
 * resolver refuses it in every role, so it can never read mail and none is owed to it.
 */
export function addressableSessionParty(
  sessionId: OrcaSessionId,
  db: OrchestrationDb | null | undefined
): OrchestrationSessionParty | null {
  try {
    return resolveOrcaSessionParty(sessionId, db)
  } catch (error) {
    if (error instanceof OrchestrationError && error.code === CODES.notLive) {
      return null
    }
    throw error
  }
}
