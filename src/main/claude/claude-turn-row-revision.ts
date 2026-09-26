// Every write to a Claude turn row is a revision of the row as the journal holds
// it at execution: a writer overrides only the fields it owns and keeps the
// rest, whoever wrote them. Nothing about ended turns is kept in memory, so a
// restart or reattach revises the same rows a live translator would.

import {
  MAX_CONTEXT_CATEGORIES,
  MAX_CONTEXT_CATEGORY_NAME_CHARS,
  MAX_CONTEXT_MODEL_ID_CHARS,
  type AgentSessionContextUsage,
  type AgentSessionContextWindow
} from '../../shared/agent-session-context-usage'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalTurnItem
} from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { estimateStructuredAgentSessionItemBytes } from '../native-chat/agent-session-wire/structured-agent-session-event-sink-estimate'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionRevisionJournal,
  StructuredAgentSessionRevisionOptions
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

/** The row a write revises: a known one, or the newest turn in the journal. */
export type ClaudeTurnRowTarget = { identity: AgentJournalItemIdentity } | { newest: true }

export type ClaudeTurnRowWrite = {
  /** The lifecycle fields this turn has now; the lifecycle writer owns all of them. */
  lifecycle?: AgentJournalTurnItem
  /** Context parts, each replacing its namesake on the row. */
  contextUsage?: AgentSessionContextUsage
  /** A window written only while no row in the journal holds one. */
  windowIfNoneHeld?: AgentSessionContextWindow
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Serialized size of the largest value of each context part the schema admits. */
const MAX_CONTEXT_PART_BYTES: Record<keyof AgentSessionContextUsage, number> = (() => {
  // A control character is the longest a JSON string can make one UTF-16 unit.
  const text = (length: number) => '\u0000'.repeat(length)
  const number = -Number.MAX_VALUE
  const worst: Required<AgentSessionContextUsage> = {
    window: { tokens: number, capturedAt: number },
    used: {
      kind: 'report',
      model: text(MAX_CONTEXT_MODEL_ID_CHARS),
      usedTokens: number,
      windowTokens: number,
      percentage: number,
      autoCompactAtTokens: number,
      categories: Array.from({ length: MAX_CONTEXT_CATEGORIES }, () => ({
        name: text(MAX_CONTEXT_CATEGORY_NAME_CHARS),
        tokens: number,
        deferred: true as const
      })),
      capturedAt: number
    }
  }
  return { window: jsonBytes(worst.window), used: jsonBytes(worst.used) }
})()

/** A part the write carries costs its own size; one kept from the row, at most the largest. */
function contextBytesBound(write: AgentSessionContextUsage | undefined): number {
  const parts: (keyof AgentSessionContextUsage)[] = ['window', 'used']
  return parts.reduce(
    (total, part) =>
      total + 32 + (write?.[part] ? jsonBytes(write[part]) : MAX_CONTEXT_PART_BYTES[part]),
    32
  )
}

/** Room for the lifecycle fields of a row this writer did not build. */
const TURN_ROW_BYTES_WITHOUT_CONTEXT = 8 * 1024

/** `lifecycle` over the row's current body, keeping every field it does not own. */
function reviseTurnBody(
  current: AgentJournalTurnItem | null,
  write: ClaudeTurnRowWrite
): AgentJournalTurnItem | null {
  const { lifecycle, contextUsage } = write
  const base =
    lifecycle && current ? { ...withoutLifecycle(current), ...lifecycle } : (lifecycle ?? current)
  if (!base || !contextUsage) {
    return base
  }
  return { ...base, contextUsage: { ...current?.contextUsage, ...contextUsage } }
}

function withoutLifecycle(turn: AgentJournalTurnItem) {
  const {
    turnId: _turnId,
    state: _state,
    outcome: _outcome,
    userItemId: _userItemId,
    startedAt: _startedAt,
    requestedAt: _requestedAt,
    completedAt: _completedAt,
    durationMs: _durationMs,
    ...kept
  } = turn
  return kept
}

/** The write with its fallback window resolved against every row, since any of them may hold the newest. */
function withFallbackWindow(
  journal: StructuredAgentSessionRevisionJournal,
  { windowIfNoneHeld, ...write }: ClaudeTurnRowWrite
): ClaudeTurnRowWrite {
  if (!windowIfNoneHeld || write.contextUsage?.window) {
    return write
  }
  let held = false
  journal.visitItems((_itemId, _sequence, body) => {
    held ||= readAgentJournalTurn(body)?.contextUsage?.window !== undefined
  })
  return held
    ? write
    : { ...write, contextUsage: { ...write.contextUsage, window: windowIfNoneHeld } }
}

function findTurnRow(
  journal: StructuredAgentSessionRevisionJournal,
  target: ClaudeTurnRowTarget
): { itemId: string; body: AgentJournalTurnItem } | null {
  if ('identity' in target) {
    const itemId = agentJournalItemKey(target.identity)
    const body = journal.itemBody(itemId)
    return body?.kind === 'turn' ? { itemId, body } : null
  }
  // Only a write made while no turn is open scans.
  let found: { itemId: string; sequence: number; body: AgentJournalTurnItem } | null = null
  journal.visitItems((itemId, sequence, body) => {
    if (body.kind === 'turn' && (found === null || sequence >= found.sequence)) {
      found = { itemId, sequence, body }
    }
  })
  return found
}

/** How a turn-row write reaches live subscribers. */
export type ClaudeTurnRowDelivery = {
  /** False only for a writer that publishes each write itself right after queueing it. */
  publish: boolean
  options?: Omit<StructuredAgentSessionRevisionOptions, 'turnScope'>
}

/**
 * Queue one revision of a Claude turn row. A lifecycle write creates the row
 * when it is absent; a context write only ever revises one that exists.
 * Without a journal-reading sink only the lifecycle is written, as it was built.
 */
export function writeClaudeTurnRow(
  sink: StructuredAgentSessionEventSink,
  target: ClaudeTurnRowTarget,
  write: ClaudeTurnRowWrite,
  { publish, options: delivery = {} }: ClaudeTurnRowDelivery
): void {
  // A turn record belongs to no turn.
  const options = { ...delivery, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  const revise = publish ? sink.tryReviseResolvedItemAndPublish : sink.tryReviseResolvedItem
  if (!revise) {
    if (write.lifecycle && 'identity' in target) {
      sink.appendItem(target.identity, write.lifecycle, options)
      if (publish) {
        sink.publish()
      }
    }
    return
  }
  const known = 'identity' in target ? target.identity : null
  const reservedBytes =
    (known && write.lifecycle
      ? estimateStructuredAgentSessionItemBytes(known, write.lifecycle)
      : TURN_ROW_BYTES_WITHOUT_CONTEXT) + contextBytesBound(write.contextUsage)
  revise.call(
    sink,
    reservedBytes,
    (journal) => {
      const row = findTurnRow(journal, target)
      const identity = known ?? (row ? parseAgentJournalItemKey(row.itemId) : null)
      const body = reviseTurnBody(row?.body ?? null, withFallbackWindow(journal, write))
      if (!identity || !body) {
        return null
      }
      if (estimateStructuredAgentSessionItemBytes(identity, body) <= reservedBytes) {
        return { identity, body }
      }
      // Only a row grown by fields this build does not know gets here; the lifecycle still lands.
      return write.lifecycle ? { identity, body: write.lifecycle } : null
    },
    options
  )
}
