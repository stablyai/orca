import type { CodexHistoryRecord } from '../../transcript-history/codex/codex-local-history'
import { readRecord, readString } from '../../../codex/app-server/codex-item-field-readers'
import { codexRolloutItem } from '../../../codex/history/rollouts/codex-rollout-item-projection'
import {
  projectCodexHistoryItem,
  projectCodexHistoryTurn
} from '../../../codex/history/journal-views/codex-history-projection'
import { codexTurnLifecycleIdentity } from '../../../codex/structured/journal/codex-structured-journal-translation-turns'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import { createNewestItemWindow } from './journal-newest-item-window'
import {
  createCodexHistoryPlacement,
  codexHistoryRootStart,
  type CodexHistoryRoot
} from './journal-codex-history-placement'
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
  root?: CodexHistoryRoot
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
  const placement = createCodexHistoryPlacement()
  let factBytes = 0,
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
    group: CodexHistoryRoot | undefined,
    at: number,
    completedSnapshot = false,
    kind: 'root' | 'opener' | 'item' = 'item'
  ) => {
    placement.set(row, window.get(key), group, at, kind, completedSnapshot)
    const turnGroup = placement.get(row)?.turnGroup
    window.upsert(key, row, 128 + (turnGroup ? Buffer.byteLength(JSON.stringify(turnGroup)) : 0))
  }
  const turnRow = (turn: Turn) => {
    const identity = codexTurnLifecycleIdentity(sessionId, turn.id)
    const key = agentJournalItemKey(identity)
    const retained = window.get(key)?.body
    const opener = retained?.kind === 'turn' ? retained.userItemId : undefined
    if (!turn.root && !retained) {
      return
    }
    const row: JournalReplacementItem = {
      identity,
      body: projectCodexHistoryTurn(segment, turn.source, turn.userItemId ?? opener),
      ownerFence: 0,
      turnScope: { kind: 'thread' }
    }
    store(key, row, turn.root, -Infinity, false, 'root')
  }
  return {
    push(row: JournalReplacementItem) {
      store(`legacy:${position++}`, row, undefined, 0)
    },
    record(descriptor: CodexHistoryRecord) {
      if (segment !== descriptor.segmentId) {
        segment = descriptor.segmentId
        facts.clear()
        factBytes = 0
        interval = null
        lastStart = -Infinity
        placement.beginSegment()
        lastRecordAt = 0
        lastTurnId = null
        window.reserve(0)
      }
      if (!descriptor.paginated) {
        return
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
      const retainedTurn = turnId
        ? window.get(agentJournalItemKey(codexTurnLifecycleIdentity(sessionId, turnId)))
        : undefined
      const root = turn?.root ?? placement.turnGroup(retainedTurn)
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
            complete: true,
            source: {
              id: turnId,
              status: 'inProgress'
            }
          }
        }
        turn ??= { id: turnId, complete: false, source: { id: turnId } }
        const startedAt = codexHistoryRootStart(payload, time)
        turn.root =
          root ?? (startedAt !== undefined ? placement.root(turnId, startedAt) : undefined)
        turn.source.startedAt ??=
          startedAt ??
          (retainedTurn?.body.kind === 'turn' && retainedTurn.body.startedAt !== undefined
            ? retainedTurn.body.startedAt / 1000
            : undefined)
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
        root,
        item.type === 'userMessage'
          ? -Infinity
          : typeof start === 'number' && Number.isFinite(start)
            ? start
            : typeof end === 'number' && Number.isFinite(end)
              ? end
              : lastRecordAt,
        payload.type === 'item_completed',
        item.type === 'userMessage' ? 'opener' : 'item'
      )
    },
    items: () => placement.items(window.items())
  }
}
