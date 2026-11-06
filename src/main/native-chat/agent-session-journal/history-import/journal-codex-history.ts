import type { CodexHistoryRecord } from '../../codex-local-history'
import { readRecord, readString } from '../../../codex/app-server/codex-item-field-readers'
import { codexRolloutItem } from '../../../codex/history/rollouts/codex-rollout-item-projection'
import { projectCodexHistoryItem } from '../../../codex/history/journal-views/codex-history-projection'
import { historicalTurnLifecycle } from '../../../codex/structured/journal/codex-structured-journal-translation-restore'
import { codexTurnLifecycleIdentity } from '../../../codex/structured/journal/codex-structured-journal-translation-turns'
import { agentJournalTurnBody } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import { createNewestItemWindow } from './journal-newest-item-window'
import {
  boundLegacyImportBlock,
  boundPayload,
  boundToolInput,
  type JournalPayloadLimits
} from '../item-lifecycle/journal-payload-bounds'
import {
  endedJournalReasoning,
  withJournalReasoningLifecycle
} from '../item-lifecycle/journal-reasoning-row'

type Turn = {
  id: string
  order: number
  complete: boolean
  source: Record<string, unknown>
  userItemId?: string
}
type Fact = {
  bytes: number
  turn?: Turn
  terminal?: number
  interrupted?: boolean
  turnKey?: string
}

export function createCodexHistoryCollector(
  sessionId: string,
  limits: JournalPayloadLimits,
  maxBytes: number
) {
  const window = createNewestItemWindow(maxBytes)
  const facts = new Map<string, Fact>()
  const placement = new WeakMap<
    JournalReplacementItem,
    { group: number; at: number; position: number }
  >()
  let factBytes = 0,
    order = 0,
    position = 0,
    segment = '',
    lastStart = -Infinity,
    lastTurnId: string | null = null
  let interval: { at: number; position: number } | null = null
  const identity = (recordId: string) => ({
    provider: 'legacy' as const,
    agent: 'codex' as const,
    sessionId,
    recordId
  })
  const remember = (key: string, fact: Omit<Fact, 'bytes'>) => {
    factBytes -= facts.get(key)?.bytes ?? 0
    const bytes = Buffer.byteLength(JSON.stringify([key, fact])) + 128
    facts.delete(key)
    facts.set(key, { ...fact, bytes })
    factBytes += bytes
    while (factBytes > maxBytes / 2 && facts.size) {
      const [oldKey, old] = facts.entries().next().value!
      facts.delete(oldKey)
      factBytes -= old.bytes
      if (old.turnKey) {
        const turn = facts.get(old.turnKey)?.turn
        if (turn) {
          turn.complete = false
        }
      }
      interval = null
    }
    window.reserve(factBytes + (interval ? 64 : 0))
  }
  const bound = (body: AgentJournalItemBody): AgentJournalItemBody => {
    if (body.kind === 'message') {
      return { ...body, blocks: body.blocks.map((block) => boundLegacyImportBlock(block, limits)) }
    }
    if (body.kind === 'tool-call') {
      return {
        ...body,
        input: boundToolInput(body.input, limits),
        ...(body.output ? { output: boundPayload(body.output.head, limits) } : {})
      }
    }
    if (body.kind === 'diff') {
      return { ...body, patch: boundPayload(body.patch.head, limits) }
    }
    return body
  }
  const store = (key: string, row: JournalReplacementItem, group: number, at: number) => {
    const previous = window.get(key)
    const firstPosition = previous ? placement.get(previous)?.position : undefined
    placement.set(row, { group, at, position: firstPosition ?? position++ })
    window.upsert(key, row, 128)
  }
  const turnRow = (turn: Turn) => {
    const lifecycle = historicalTurnLifecycle(segment, turn.source)!
    if (turn.userItemId) {
      lifecycle.userItemId = turn.userItemId
    } else {
      delete lifecycle.userItemId
    }
    const id = codexTurnLifecycleIdentity(sessionId, turn.id)
    store(
      `turn:${segment}:${turn.id}`,
      {
        identity: id,
        body: agentJournalTurnBody(lifecycle),
        ownerFence: 0,
        turnScope: { kind: 'thread' }
      },
      turn.order,
      -Infinity
    )
  }
  return {
    push(row: JournalReplacementItem) {
      store(`legacy:${position}`, row, ++order, position)
    },
    record(descriptor: CodexHistoryRecord) {
      if (!descriptor.paginated) {
        return
      }
      if (segment !== descriptor.segmentId) {
        segment = descriptor.segmentId
        facts.clear()
        factBytes = 0
        interval = null
        lastStart = -Infinity
        lastTurnId = null
        window.reserve(0)
      }
      const record = descriptor.record
      if (record?.type !== 'event_msg') {
        return
      }
      const payload = readRecord(record.payload)
      const turnId = readString(payload, 'turn_id')
      const turnKey = `turn:${segment}:${turnId}`
      const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
      let turn = facts.get(turnKey)?.turn
      if (['task_started', 'task_complete', 'turn_aborted'].includes(String(payload.type))) {
        if (!turnId) {
          return
        }
        if (
          payload.type === 'task_started' &&
          !turn &&
          turnId !== lastTurnId &&
          Number.isFinite(time) &&
          time > lastStart
        ) {
          interval = null
          lastStart = time
          lastTurnId = turnId
          turn = {
            id: turnId,
            order: ++order,
            complete: true,
            source: {
              id: turnId,
              status: 'inProgress',
              startedAt: typeof payload.started_at === 'number' ? payload.started_at : time / 1000
            }
          }
        }
        if (!turn) {
          turn = { id: turnId, order: -1, complete: false, source: { id: turnId } }
        }
        if (payload.type !== 'task_started') {
          const wasTerminal = ['completed', 'failed', 'interrupted'].includes(
            String(turn.source.status)
          )
          turn.source = {
            ...turn.source,
            status:
              payload.type === 'turn_aborted'
                ? 'interrupted'
                : payload.error == null
                  ? 'completed'
                  : 'failed',
            ...(Number.isFinite(time)
              ? {
                  completedAt:
                    typeof payload.completed_at === 'number' ? payload.completed_at : time / 1000
                }
              : {}),
            durationMs: payload.duration_ms
          }
          if (
            !wasTerminal &&
            payload.type === 'turn_aborted' &&
            payload.reason === 'interrupted' &&
            Number.isFinite(time) &&
            time >= lastStart
          ) {
            interval = { at: time, position: descriptor.ordinal }
          }
        }
        remember(turnKey, { turn })
        turnRow(turn)
        return
      }
      if (payload.type !== 'item_completed') {
        return
      }
      const item = codexRolloutItem(payload.item)
      if (!item?.id) {
        return
      }
      const key = `${segment}:${item.id}`
      const old = facts.get(key)
      const terminal = ['completed', 'failed', 'declined', 'interrupted'].includes(
        String(item.status)
      )
      const first = old?.terminal ?? (terminal && turn?.complete ? descriptor.ordinal : undefined)
      const start = payload.started_at_ms,
        end = payload.completed_at_ms
      const newlyInterrupted =
        item.type === 'commandExecution' &&
        item.source === 'unifiedExecStartup' &&
        typeof item.processId === 'string' &&
        item.processId.length > 0 &&
        item.status === 'failed' &&
        item.exitCode === -1 &&
        interval !== null &&
        first !== undefined &&
        first > interval.position &&
        typeof start === 'number' &&
        typeof end === 'number' &&
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start <= interval.at &&
        interval.at <= end
      const interrupted =
        newlyInterrupted ||
        (old?.interrupted === true && item.status === 'failed' && item.exitCode === -1)
      const body = projectCodexHistoryItem(item, null, interrupted)
      if (item.type === 'commandExecution') {
        remember(key, { terminal: first, interrupted, turnKey })
      }
      if (!body) {
        return
      }
      const row: JournalReplacementItem = {
        identity: identity(descriptor.recordId),
        body: bound(withJournalReasoningLifecycle(body, endedJournalReasoning())),
        ownerFence: 0,
        ...(Number.isFinite(time) ? { observedAt: time } : {}),
        turnScope: turnId
          ? {
              kind: 'turn',
              turnItemId: agentJournalItemKey(codexTurnLifecycleIdentity(sessionId, turnId))
            }
          : { kind: 'thread' }
      }
      if (item.type === 'userMessage' && turn) {
        turn.userItemId = agentJournalItemKey(row.identity)
        remember(turnKey, { turn })
        turnRow(turn)
      }
      store(
        item.type === 'contextCompaction' ? `compaction:${segment}:${turnId}` : key,
        row,
        turn?.order ?? (lastStart > -Infinity ? -1 : ++order),
        item.type === 'userMessage'
          ? -Infinity
          : typeof start === 'number' && Number.isFinite(start)
            ? start
            : descriptor.ordinal
      )
    },
    items: () => {
      const rows = window.items()
      const keys = new Set(rows.map((row) => agentJournalItemKey(row.identity)))
      for (const row of rows) {
        if (row.body.kind === 'turn' && row.body.userItemId && !keys.has(row.body.userItemId)) {
          delete row.body.userItemId
        }
      }
      return rows.sort((a, b) => {
        const x = placement.get(a)!,
          y = placement.get(b)!
        return x.group - y.group || x.at - y.at || x.position - y.position
      })
    }
  }
}
