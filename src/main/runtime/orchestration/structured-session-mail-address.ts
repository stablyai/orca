/**
 * A structured agent session as a mail address: `session:<id>`, the Orca-minted id every agent is
 * told is its public address. Recipient routing and pointer delivery both read these rules off the
 * durable session record, so the two can never disagree about which sessions mail can reach.
 *
 * A released lease does not end a session. The host evicts a chat nobody is looking at 15s after
 * its last turn and hands its lease back, and mail must wake it again (resume on demand). For mail,
 * a session has ended only when its chat was closed or `/clear` replaced it with another session.
 */

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { formatOrchestrationActor } from '../../../shared/orchestration-actor'
import { resolveStructuredWorkerIdentityForSession } from '../structured-worker-authority'
import { structuredWorkerHostScope } from '../structured-worker-identity'
import type { OrchestrationDb } from './db'
import { isRecordedStructuredWorkerActor } from './db/schema/structured-worker-actor-backfill'
import type { OrchestrationCallerIdentity } from './orchestration-caller-identity'

export type AgentSessionRecordReader = {
  getRecord: (sessionId: string) => AgentSessionRecord | null
  listRecords: () => AgentSessionRecord[]
  /** Absent on a store that predates tab visibility; every session then counts as open. */
  getVisibleSessionTabIndex?: () => { present: boolean; sessionIds: string[] }
}

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
  | { kind: 'reachable' }
  | { kind: 'other-host' }
  | { kind: 'ended'; reason: 'closed' | 'worker-identity-lost' }
  | { kind: 'ended'; reason: 'replaced'; replacementSessionId: string }

export function structuredSessionMailReach(
  store: AgentSessionRecordReader,
  record: AgentSessionRecord,
  db: OrchestrationDb | null | undefined
): StructuredSessionMailReach {
  if (!structuredWorkerHostScope(record.location)) {
    return { kind: 'other-host' }
  }
  const actor = formatOrchestrationActor({ kind: 'session', id: record.sessionId })
  if (
    db &&
    !resolveStructuredWorkerIdentityForSession(record.sessionId, db) &&
    isRecordedStructuredWorkerActor(db.db, actor)
  ) {
    // Why: it can no longer act (the caller resolver refuses it), so mail to it could never be read.
    return { kind: 'ended', reason: 'worker-identity-lost' }
  }
  const command = record.conversationCommand
  if (
    command?.command === 'clear' &&
    command.phase === 'committed' &&
    command.replacementSessionId
  ) {
    return { kind: 'ended', reason: 'replaced', replacementSessionId: command.replacementSessionId }
  }
  const visible = store.getVisibleSessionTabIndex?.()
  if (visible?.present && !visible.sessionIds.includes(record.sessionId)) {
    // Why: reviving a chat the user closed would run turns nobody can see; its mail waits instead.
    return { kind: 'ended', reason: 'closed' }
  }
  return { kind: 'reachable' }
}

/**
 * Which view carries a pointer to the session right now. A terminal view owns the session while a
 * TUI holds its lease, and its PTY takes the pointer; otherwise the host sends a session turn,
 * resuming an evicted session for it.
 */
export function structuredSessionDeliveryView(
  record: AgentSessionRecord
): 'session-turn' | 'terminal-view' {
  return record.lease.runtimeKind === 'tui' && record.lease.claimStatus !== 'released'
    ? 'terminal-view'
    : 'session-turn'
}

/**
 * Who a session is to orchestration: its actor, plus the handle and pane a structured worker was
 * minted. The caller resolver and mail delivery both take it from here, so a session is matched the
 * same way whether it is sending, checking, or being delivered to.
 */
export function sessionOrchestrationIdentity(
  sessionId: string,
  db: OrchestrationDb | null | undefined
): OrchestrationCallerIdentity & { actor: string } {
  const actor = formatOrchestrationActor({ kind: 'session', id: sessionId })
  const worker = resolveStructuredWorkerIdentityForSession(sessionId, db)
  return {
    actor,
    address: worker?.handle ?? actor,
    terminalHandle: worker?.handle ?? null,
    paneKey: worker?.paneKey ?? null
  }
}
