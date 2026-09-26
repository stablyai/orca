/**
 * A structured session's `/clear` lineage, read off the durable session records. `/clear` continues
 * a chat in a new session; the committed clear on the old record names the session that replaced it.
 * Derived from the records every time; nothing is rewritten at a clear.
 */

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../shared/orchestration-session-caller-codes'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredWorkerHostScope } from '../structured-worker-identity'
import { OrchestrationError } from './orchestration-error'

export type AgentSessionRecordReader = {
  getRecord: (sessionId: string) => AgentSessionRecord | null
  listRecords: () => AgentSessionRecord[]
  /** Absent on a store that predates tab visibility; every session then counts as open. */
  getVisibleSessionTabIndex?: () => { present: boolean; sessionIds: string[] }
}

/** Null until the agent-session host is installed; callers that must see records ensure it first. */
export function readAgentSessionRecordStore(): AgentSessionRecordReader | null {
  return getStructuredAgentSessionHost()?.deps.store ?? null
}

/** The session a committed `/clear` continued this one in, if any. */
export function clearedInto(record: AgentSessionRecord): string | null {
  const command = record.conversationCommand
  return command?.command === 'clear' && command.phase === 'committed'
    ? (command.replacementSessionId ?? null)
    : null
}

/**
 * Where the session running `sessionId`'s conversation now can be served: this host has it, another
 * host runs it, or the lineage names a session with no record. The one lineage walk behind every
 * read, observation, stop and mail delivery of a session Orca assigned work to; each caller maps
 * the result to its own vocabulary, and a store it cannot read is a typed refusal, never a guess.
 */
export type ExecutingSession =
  | { kind: 'here'; sessionId: string; record: AgentSessionRecord }
  | { kind: 'other-host'; sessionId: string; record: AgentSessionRecord }
  | { kind: 'unrecorded'; sessionId: string }

export function resolveExecutingSession(
  store: AgentSessionRecordReader,
  sessionId: string
): ExecutingSession {
  try {
    let head = sessionId
    const later = new Set([sessionId])
    let record = store.getRecord(head)
    let next = record ? clearedInto(record) : null
    while (record && next && !later.has(next)) {
      later.add(next)
      head = next
      record = store.getRecord(head)
      next = record ? clearedInto(record) : null
    }
    if (!record) {
      return { kind: 'unrecorded', sessionId: head }
    }
    return structuredWorkerHostScope(record.location)
      ? { kind: 'here', sessionId: head, record }
      : { kind: 'other-host', sessionId: head, record }
  } catch (error) {
    throw new OrchestrationError(
      CODES.notLive,
      `Agent session ${sessionId} cannot be verified: its session record could not be read (${error instanceof Error ? error.message : String(error)}). No effects were applied.`,
      { effectsApplied: false }
    )
  }
}

/** The typed refusal for a session another host runs; a caller here cannot act on it. */
export function otherHostSessionRefusal(sessionId: string): OrchestrationError {
  return new OrchestrationError(
    CODES.hostBoundary,
    `Agent session ${sessionId} runs on another host; act on it from the host that runs it. No effects were applied.`,
    { effectsApplied: false }
  )
}

/**
 * The session running `sessionId`'s conversation now: itself, or its live `/clear` successor. With
 * no record store installed there is no lineage to read, and the id stands for itself; readers then
 * report the session unverifiable. Another host is refused.
 */
export function executingSessionId(
  sessionId: string,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): string {
  if (!store) {
    return sessionId
  }
  const executing = resolveExecutingSession(store, sessionId)
  if (executing.kind === 'other-host') {
    throw otherHostSessionRefusal(sessionId)
  }
  return executing.sessionId
}
