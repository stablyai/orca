import type { CodexHistoryRecord } from '../../codex-local-history'
import { readRecord, readString } from '../../../codex/app-server/codex-item-field-readers'
import { codexRolloutItem } from '../../../codex/history/rollouts/codex-rollout-item-projection'
import { projectCodexHistoryItem } from '../../../codex/history/journal-views/codex-history-projection'
import { historicalTurnLifecycle } from '../../../codex/structured/journal/codex-structured-journal-translation-restore'
import { codexTurnLifecycleIdentity } from '../../../codex/structured/journal/codex-structured-journal-translation-turns'
import { agentJournalTurnBody } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import { createNewestItemWindow } from './journal-newest-item-window'
import {
  boundLegacyImportBody,
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
  firstTerminal?: number
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
    { group: number; at: number; position: number; completedSnapshot: boolean }
  >()
  let factBytes = 0,
    order = 0,
    position = 0,
    segment = '',
    lastStart = -Infinity,
    lastRecordAt = 0,
    lastTurnId: string | null = null
  let interval: { at: number; position: number; turnKey: string } | null = null
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
      if (oldKey === interval?.turnKey) {
        interval = null
      }
    }
    window.reserve(factBytes + (interval ? Buffer.byteLength(interval.turnKey) + 64 : 0))
  }
  const store = (
    key: string,
    row: JournalReplacementItem,
    group: number,
    at: number,
    completedSnapshot = false
  ) => {
    const previous = placement.get(window.get(key) ?? row)
    placement.set(row, { group, at, position: previous?.position ?? position++, completedSnapshot })
    window.upsert(key, row, 128)
  }
  const turnRow = (turn: Turn) => {
    const lifecycle = historicalTurnLifecycle(segment, turn.source)!
    delete lifecycle.userItemId
    if (turn.userItemId) {
      lifecycle.userItemId = turn.userItemId
    }
    store(
      `turn:${segment}:${turn.id}`,
      {
        identity: codexTurnLifecycleIdentity(sessionId, turn.id),
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
        lastRecordAt = 0
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
      if (Number.isFinite(time)) {
        lastRecordAt = time
      }
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
          turn = { id: turnId, order: ++order, complete: false, source: { id: turnId } }
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
            interval = { at: time, position: descriptor.ordinal, turnKey }
          }
        }
        remember(turnKey, { turn })
        turnRow(turn)
        return
      }
      if (payload.type !== 'item_completed' && payload.type !== 'item_started') {
        return
      }
      const item = codexRolloutItem(payload.item)
      if (!item?.id) {
        return
      }
      const key = `${segment}:${item.id}`
      const rowKey = item.type === 'contextCompaction' ? `compaction:${segment}:${turnId}` : key
      const old = facts.get(key)
      const retained = window.get(rowKey)
      if (
        payload.type === 'item_started' &&
        ((retained && placement.get(retained)?.completedSnapshot) ||
          old?.firstTerminal !== undefined)
      ) {
        return
      }
      const terminal =
        payload.type === 'item_completed' &&
        ['completed', 'failed', 'declined', 'interrupted'].includes(String(item.status))
      const first =
        old?.firstTerminal ?? (terminal && turn?.complete ? descriptor.ordinal : undefined)
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
        remember(key, { firstTerminal: first, interrupted, turnKey })
      }
      if (!body) {
        return
      }
      const row: JournalReplacementItem = {
        identity: {
          provider: 'legacy',
          agent: 'codex',
          sessionId,
          recordId: descriptor.recordId
        },
        body: boundLegacyImportBody(
          withJournalReasoningLifecycle(body, endedJournalReasoning()),
          limits
        ),
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
        rowKey,
        row,
        turn?.order ?? ++order,
        item.type === 'userMessage'
          ? -Infinity
          : typeof start === 'number' && Number.isFinite(start)
            ? start
            : typeof end === 'number' && Number.isFinite(end)
              ? end
              : lastRecordAt,
        payload.type === 'item_completed'
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
