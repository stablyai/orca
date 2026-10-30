/** Resolve /clear successors from committed durable pointers on each read; clearing rewrites no callers. */

import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import { structuredWorkerHostScope } from '../structured-worker-identity'

export type AgentSessionRecordReader = {
  getRecord: (sessionId: string) => AgentSessionConversationView | null
  listRecords: () => AgentSessionConversationView[]
  /** Absent on a store that predates tab visibility; every session then counts as open. */
  getVisibleSessionTabIndex?: () => { present: boolean; sessionIds: string[] }
}

/** Null until the agent-session host is installed; callers that must see records ensure it first. */
export function readAgentSessionRecordStore(): AgentSessionRecordReader | null {
  const store = getStructuredAgentSessionHost()?.deps.store
  return store ? conversationRecordReader(store) : null
}

export function conversationRecordReader(store: {
  getConversation: AgentSessionRecordReader['getRecord']
  listConversations: AgentSessionRecordReader['listRecords']
  getVisibleSessionTabIndex: NonNullable<AgentSessionRecordReader['getVisibleSessionTabIndex']>
}): AgentSessionRecordReader {
  return {
    getRecord: store.getConversation,
    listRecords: store.listConversations,
    getVisibleSessionTabIndex: store.getVisibleSessionTabIndex
  }
}

/** The session a committed `/clear` continued this one in, if any. */
export function clearedInto(record: AgentSessionConversationView): string | null {
  const command = record.conversationCommand
  return command?.command === 'clear' && command.phase === 'committed'
    ? (command.replacementSessionId ?? null)
    : null
}

/** The session running a lineage now, its record, and every session of the lineage up to it. */
export type RunningStructuredSession = {
  readonly sessionId: string
  readonly record: AgentSessionConversationView
  readonly lineage: readonly string[]
}

/** Walked lineage and its live location; unreadable stores, missing successors and corrupt chains never prove the conversation ended. */
export type LineageRunningSession =
  | ({ kind: 'here' } & RunningStructuredSession)
  | ({ kind: 'other-host' } & RunningStructuredSession)
  | { kind: 'unverifiable'; reason: string; lineage: readonly string[] }

/** The one forward walk: which session runs `sessionId`'s conversation now. */
export function resolveLineageRunningSession(
  store: AgentSessionRecordReader | null,
  sessionId: string
): LineageRunningSession {
  const lineage = [sessionId]
  const visited = new Set(lineage)
  if (!store) {
    return {
      kind: 'unverifiable',
      reason: 'The structured agent-session host is not installed in this runtime generation.',
      lineage
    }
  }
  let current = sessionId
  for (;;) {
    let record: AgentSessionConversationView | null
    try {
      record = store.getRecord(current)
    } catch {
      record = null
    }
    if (!record) {
      // A clear writes the successor with its pointer, so a missing record is unreadable.
      return {
        kind: 'unverifiable',
        reason: `No durable record backs structured session ${current}.`,
        lineage
      }
    }
    const next = clearedInto(record)
    if (!next) {
      const running = { sessionId: current, record, lineage }
      return structuredWorkerHostScope(record.location)
        ? { kind: 'here', ...running }
        : { kind: 'other-host', ...running }
    }
    if (visited.has(next)) {
      return {
        kind: 'unverifiable',
        reason: `The /clear lineage of structured session ${sessionId} loops back on itself.`,
        lineage
      }
    }
    visited.add(next)
    lineage.push(next)
    current = next
  }
}

/** The record running the lineage now; null when that cannot be verified. */
export function lineageLiveSession(
  store: AgentSessionRecordReader,
  sessionId: string
): AgentSessionConversationView | null {
  const running = resolveLineageRunningSession(store, sessionId)
  return running.kind === 'unverifiable' ? null : running.record
}

/** Canonical host status keys; this build-local resolver shares successful suffixes and failed verdicts. */
export function createCanonicalSessionPaneResolver(
  store: AgentSessionRecordReader | null
): (sessionId: string) => string {
  const resolved = new Map<string, string | null>()
  return (sessionId) => {
    let current = sessionId
    const path = new Set<string>()
    let destination: string | null = null
    for (;;) {
      if (resolved.has(current)) {
        destination = resolved.get(current) ?? null
        break
      }
      if (path.has(current)) {
        break
      }
      path.add(current)
      let record: AgentSessionConversationView | null
      try {
        record = store?.getRecord(current) ?? null
      } catch {
        record = null
      }
      if (!record) {
        break
      }
      const next = clearedInto(record)
      if (!next) {
        destination = current
        break
      }
      current = next
    }
    for (const member of path) {
      resolved.set(member, destination)
    }
    const id = destination ?? sessionId
    return structuredAgentSessionPaneKey(structuredAgentSessionTabId(id), id)
  }
}
