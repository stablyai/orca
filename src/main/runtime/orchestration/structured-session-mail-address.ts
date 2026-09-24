/**
 * A structured agent session as a mail address: `session:<id>`, the Orca-minted id every agent is
 * told is its public address. Recipient routing and pointer delivery both read these rules off the
 * durable session record, so the two can never disagree about which sessions mail can reach.
 *
 * The address names a conversation, not one session of it. `/clear` continues a chat in a new
 * session, and the conversation keeps the address of its first session (its lineage root): a Run it
 * coordinates, mail sent to it, and what it sends all stay under that one spelling, and any session
 * of the lineage names it. Derived from the records every time; nothing is rewritten at a clear.
 *
 * A released lease does not end a session. The host evicts a chat nobody is looking at 15s after
 * its last turn and hands its lease back, and mail must wake it again (resume on demand). For mail,
 * a conversation has ended only when its chat was closed.
 */

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  formatOrchestrationActor,
  parseOrchestrationActor
} from '../../../shared/orchestration-actor'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  isRecordedStructuredWorkerSession,
  resolveStructuredWorkerIdentityForSession
} from '../structured-worker-authority'
import { structuredWorkerHostScope } from '../structured-worker-identity'
import type { OrchestrationDb } from './db'
import type { OrchestrationCallerIdentity } from './orchestration-caller-identity'

export type AgentSessionRecordReader = {
  getRecord: (sessionId: string) => AgentSessionRecord | null
  listRecords: () => AgentSessionRecord[]
  /** Absent on a store that predates tab visibility; every session then counts as open. */
  getVisibleSessionTabIndex?: () => { present: boolean; sessionIds: string[] }
}

export function readAgentSessionRecordStore(): AgentSessionRecordReader | null {
  return getStructuredAgentSessionHost()?.deps.store ?? null
}

/** The session a committed `/clear` continued this one in, if any. */
function clearedInto(record: AgentSessionRecord): string | null {
  const command = record.conversationCommand
  return command?.command === 'clear' && command.phase === 'committed'
    ? (command.replacementSessionId ?? null)
    : null
}

export type StructuredSessionLineage = {
  /** The conversation's first session: its address for as long as the conversation lasts. */
  rootSessionId: string
  /** The session running the conversation now; null when the chain names a session with no record. */
  live: AgentSessionRecord | null
}

/** Any session of a `/clear` lineage, resolved to the lineage's root and its live end. */
export function structuredSessionLineage(
  store: AgentSessionRecordReader,
  sessionId: string
): StructuredSessionLineage {
  const clearedFrom = new Map<string, string>()
  for (const record of store.listRecords()) {
    const next = clearedInto(record)
    if (next) {
      clearedFrom.set(next, record.sessionId)
    }
  }
  // A clear chain is acyclic by construction; the visited sets only bound a corrupt store.
  let rootSessionId = sessionId
  const earlier = new Set([sessionId])
  let prior = clearedFrom.get(rootSessionId)
  while (prior && !earlier.has(prior)) {
    earlier.add(prior)
    rootSessionId = prior
    prior = clearedFrom.get(rootSessionId)
  }
  let live = store.getRecord(sessionId)
  const later = new Set([sessionId])
  let next = live ? clearedInto(live) : null
  while (live && next && !later.has(next)) {
    later.add(next)
    live = store.getRecord(next)
    next = live ? clearedInto(live) : null
  }
  return { rootSessionId, live }
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
  const live = structuredSessionLineage(store, record.sessionId).live
  if (!live) {
    return { kind: 'ended', reason: 'continuation-missing' }
  }
  if (!structuredWorkerHostScope(live.location)) {
    return { kind: 'other-host' }
  }
  const identity = sessionOrchestrationIdentity(live.sessionId, db, store)
  if (db && hasLostStructuredWorkerIdentity(identity, db)) {
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
 * Who a session is to orchestration: its conversation's actor, plus the handle and pane a structured
 * worker was minted. The caller resolver and mail delivery both take it from here, so a session is
 * matched the same way whether it is sending, checking, or being delivered to. Without a record
 * store there is no lineage to read, and the id stands for itself.
 */
export function sessionOrchestrationIdentity(
  sessionId: string,
  db: OrchestrationDb | null | undefined,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): OrchestrationCallerIdentity & { actor: string } {
  const lineage = store ? structuredSessionLineage(store, sessionId) : null
  const actor = formatOrchestrationActor({
    kind: 'session',
    id: lineage?.rootSessionId ?? sessionId
  })
  // A worker identity is minted for one session, so it is looked up on the one running now.
  const worker = resolveStructuredWorkerIdentityForSession(
    lineage?.live?.sessionId ?? sessionId,
    db
  )
  return {
    actor,
    address: worker?.handle ?? actor,
    terminalHandle: worker?.handle ?? null,
    paneKey: worker?.paneKey ?? null
  }
}

/**
 * A structured worker whose worker identity this host no longer has. It may not act handle-less (that
 * would split one worker into two identities), so mail to it could never be read either. Checked on
 * the conversation, whose root session is the one a Dispatch assigned.
 */
export function hasLostStructuredWorkerIdentity(
  identity: OrchestrationCallerIdentity & { actor: string },
  db: OrchestrationDb
): boolean {
  const conversation = parseOrchestrationActor(identity.actor)
  return (
    identity.terminalHandle === null &&
    conversation !== null &&
    isRecordedStructuredWorkerSession(conversation.id, db)
  )
}
