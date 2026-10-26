// Resolve revisions from journal state at execution; each writer preserves fields it does not own.

import {
  MAX_CONTEXT_CATEGORIES,
  MAX_CONTEXT_CATEGORY_NAME_CHARS,
  MAX_CONTEXT_MODEL_ID_CHARS,
  type AgentSessionContextUsage,
  type AgentSessionContextWindow
} from '../../../shared/agent-session-context-usage'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalTurnItem
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { estimateStructuredAgentSessionItemBytes } from '../agent-session-wire/structured-agent-session-event-sink-estimate'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionRevisionJournal,
  StructuredAgentSessionRevisionOptions
} from '../agent-session-wire/structured-agent-session-event-sink'

export type AgentJournalTurnRowTarget = { identity: AgentJournalItemIdentity } | { newest: true }

export type AgentJournalTurnRowWrite = {
  /** Lifecycle writers own all lifecycle fields. */
  lifecycle?: AgentJournalTurnItem
  /** Replace only the supplied context parts. */
  contextUsage?: AgentSessionContextUsage
  /** Supply a window only when no journal row holds one. */
  windowIfNoneHeld?: AgentSessionContextWindow
  /** Never overwrite ended turns. */
  onlyWhileRunning?: true
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

const MAX_CONTEXT_PART_BYTES: Record<keyof AgentSessionContextUsage, number> = (() => {
  // JSON escapes control characters to the largest per-unit representation.
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

/** Bound retained parts conservatively; supplied parts use their actual size. */
function contextBytesBound(write: AgentSessionContextUsage | undefined): number {
  const parts: (keyof AgentSessionContextUsage)[] = ['window', 'used']
  return parts.reduce(
    (total, part) =>
      total + 32 + (write?.[part] ? jsonBytes(write[part]) : MAX_CONTEXT_PART_BYTES[part]),
    32
  )
}

/** Reserve lifecycle space even for rows created by other writers. */
const TURN_ROW_BYTES_WITHOUT_CONTEXT = 8 * 1024

function reviseTurnBody(
  current: AgentJournalTurnItem | null,
  write: AgentJournalTurnRowWrite
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

function withFallbackWindow(
  journal: StructuredAgentSessionRevisionJournal,
  { windowIfNoneHeld, ...write }: AgentJournalTurnRowWrite
): AgentJournalTurnRowWrite {
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
  target: AgentJournalTurnRowTarget
): { itemId: string; body: AgentJournalTurnItem } | null {
  if ('identity' in target) {
    const itemId = agentJournalItemKey(target.identity)
    const body = journal.itemBody(itemId)
    return body?.kind === 'turn' ? { itemId, body } : null
  }
  let found: { itemId: string; sequence: number; body: AgentJournalTurnItem } | null = null
  journal.visitItems((itemId, sequence, body) => {
    if (body.kind === 'turn' && (found === null || sequence >= found.sequence)) {
      found = { itemId, sequence, body }
    }
  })
  return found
}

export type AgentJournalTurnRowDelivery = {
  /** False when the caller publishes immediately after queueing. */
  publish: boolean
  options?: Omit<StructuredAgentSessionRevisionOptions, 'turnScope'>
}

export function agentJournalTurnRowReservedBytes(
  target: AgentJournalTurnRowTarget,
  write: AgentJournalTurnRowWrite
): number {
  const known = 'identity' in target ? target.identity : null
  return (
    (known && write.lifecycle
      ? estimateStructuredAgentSessionItemBytes(known, write.lifecycle)
      : TURN_ROW_BYTES_WITHOUT_CONTEXT) + contextBytesBound(write.contextUsage)
  )
}

/** Resolve against current journal state; null writes nothing. */
export function resolveAgentJournalTurnRowWrite(
  journal: StructuredAgentSessionRevisionJournal,
  target: AgentJournalTurnRowTarget,
  write: AgentJournalTurnRowWrite,
  reservedBytes: number
): { identity: AgentJournalItemIdentity; body: AgentJournalTurnItem } | null {
  const known = 'identity' in target ? target.identity : null
  const row = findTurnRow(journal, target)
  if (write.onlyWhileRunning && row && row.body.state !== 'running') {
    return null
  }
  const identity = known ?? (row ? parseAgentJournalItemKey(row.itemId) : null)
  const body = reviseTurnBody(row?.body ?? null, withFallbackWindow(journal, write))
  if (!identity || !body) {
    return null
  }
  if (estimateStructuredAgentSessionItemBytes(identity, body) <= reservedBytes) {
    return { identity, body }
  }
  // Unknown fields can exceed the bound; preserve lifecycle delivery anyway.
  return write.lifecycle ? { identity, body: write.lifecycle } : null
}

/** Lifecycle writes may create rows; context writes only revise. Nonreading sinks receive lifecycle only. */
export function writeAgentJournalTurnRow(
  sink: StructuredAgentSessionEventSink,
  target: AgentJournalTurnRowTarget,
  write: AgentJournalTurnRowWrite,
  { publish, options: delivery = {} }: AgentJournalTurnRowDelivery
): void {
  // Turn records are thread-scoped.
  const options = { ...delivery, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  const revise = publish ? sink.tryReviseResolvedItemAndPublish : sink.tryReviseResolvedItem
  if (!revise) {
    if (write.lifecycle && 'identity' in target) {
      sink.appendItem(target.identity, write.lifecycle, options)
      if (publish) {
        sink.publish({ criticalRoot: delivery.criticalRoot })
      }
    }
    return
  }
  const reservedBytes = agentJournalTurnRowReservedBytes(target, write)
  revise.call(
    sink,
    reservedBytes,
    (journal) => resolveAgentJournalTurnRowWrite(journal, target, write, reservedBytes),
    options
  )
}
