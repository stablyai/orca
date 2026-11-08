import {
  codexHistoryStartupInterrupted,
  type CodexHistoryTurnFact as Turn,
  type CodexHistoryFact as Fact,
  type CodexHistoryInterruptInterval
} from './journal-codex-history-terminal-proof'
import { prepareLegacyImportRowWork } from './journal-legacy-import-item'
import { finishTranscriptWork, type TranscriptWork } from '../../transcript-work-scheduler'
import type { CodexHistoryRecord } from '../../codex-local-history'
import { readRecord, readString } from '../../../codex/app-server/codex-item-field-readers'
import { codexRolloutItemWork } from '../../../codex/history/rollouts/codex-rollout-item-projection'
import * as history from '../../../codex/history/journal-views/codex-history-projection'
import { codexTurnLifecycleIdentity } from '../../../codex/structured/journal/codex-structured-journal-translation-turns'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import { createNewestItemWindow } from './journal-newest-item-window'
import {
  createCodexHistoryPlacement,
  codexHistoryRootStart,
  type CodexHistoryRoot
} from './journal-codex-history-placement'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'
import {
  endedJournalReasoning,
  withJournalReasoningLifecycle
} from '../item-lifecycle/journal-reasoning-row'
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
  let interval: CodexHistoryInterruptInterval | null = null
  function* rememberWork(key: string, fact: Omit<Fact, 'bytes'>): TranscriptWork<void> {
    factBytes -= facts.get(key)?.bytes ?? 0
    const bytes = Buffer.byteLength(JSON.stringify([key, fact])) + 128
    facts.delete(key)
    facts.set(key, { ...fact, bytes })
    factBytes += bytes
    while (factBytes > maxBytes / 2 && facts.size) {
      const [oldKey, old] = facts.entries().next().value!
      facts.delete(oldKey)
      factBytes -= old.bytes
      yield 1
      const turn = old.turnKey ? facts.get(old.turnKey)?.turn : undefined
      if (turn) {
        turn.complete = false
      }
      if (oldKey === interval?.turnKey) {
        interval = null
      }
    }
    yield* window.reserveWork(factBytes + (interval ? Buffer.byteLength(interval.turnKey) + 64 : 0))
  }
  function* storeWork(
    key: string,
    row: JournalReplacementItem,
    group: CodexHistoryRoot | undefined,
    at: number,
    completedSnapshot = false,
    kind: 'root' | 'opener' | 'item' = 'item'
  ): TranscriptWork<void> {
    const prepared = yield* prepareLegacyImportRowWork(row, limits)
    placement.set(prepared.item, window.get(key), group, at, kind, completedSnapshot)
    const turnGroup = placement.get(prepared.item)?.turnGroup
    yield* window.upsertWork(
      key,
      prepared.item,
      prepared.bytes,
      128 + (turnGroup ? Buffer.byteLength(JSON.stringify(turnGroup)) : 0)
    )
  }
  function* turnRowWork(turn: Turn): TranscriptWork<void> {
    const identity = codexTurnLifecycleIdentity(sessionId, turn.id)
    const key = agentJournalItemKey(identity)
    const retained = window.get(key)?.body
    const opener = retained?.kind === 'turn' ? retained.userItemId : undefined
    if (!turn.root && !retained) {
      return
    }
    const row: JournalReplacementItem = {
      identity,
      body: history.projectCodexHistoryTurn(segment, turn.source, turn.userItemId ?? opener),
      ownerFence: 0,
      turnScope: { kind: 'thread' }
    }
    yield* storeWork(key, row, turn.root, -Infinity, false, 'root')
  }
  function* pushWork(row: JournalReplacementItem, itemBytes: number): TranscriptWork<void> {
    const key = `legacy:${position++}`
    placement.set(row, window.get(key), undefined, 0, 'item', false)
    yield* window.upsertWork(key, row, itemBytes, 128)
  }
  return {
    push: (row: JournalReplacementItem) =>
      finishTranscriptWork(pushWork(row, Buffer.byteLength(JSON.stringify(row)))),
    pushWork,
    record: (descriptor: CodexHistoryRecord) => finishTranscriptWork(recordWork(descriptor)),
    recordWork,
    items: () => placement.items(window.items()),
    *itemsWork(): TranscriptWork<JournalReplacementItem[]> {
      return yield* placement.itemsWork(yield* window.itemsWork())
    }
  }
  function* recordWork(descriptor: CodexHistoryRecord): TranscriptWork<void> {
    if (segment !== descriptor.segmentId) {
      segment = descriptor.segmentId
      facts.clear()
      factBytes = 0
      interval = null
      lastStart = -Infinity
      placement.beginSegment()
      lastRecordAt = 0
      lastTurnId = null
      yield* window.reserveWork(0)
    }
    const record = descriptor.record
    if (!descriptor.paginated || record?.type !== 'event_msg') {
      return
    }
    const payload = readRecord(record.payload)
    const turnId = readString(payload, 'turn_id')
    const turnKey = `turn:${segment}:${turnId}`
    const time = Date.parse(typeof record.timestamp === 'string' ? record.timestamp : '')
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
      turn.root = root ?? (startedAt !== undefined ? placement.root(turnId, startedAt) : undefined)
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
      yield* rememberWork(turnKey, { turn })
      yield* turnRowWork(turn)
      return
    }
    if (payload.type !== 'item_completed' && payload.type !== 'item_started') {
      return
    }
    const item = yield* codexRolloutItemWork(payload.item)
    if (!item?.id) {
      return
    }
    const key = `${segment}:${item.id}`
    const rowKey = item.type === 'contextCompaction' ? `compaction:${segment}:${turnId}` : key
    const old = facts.get(key)
    const retained = window.get(rowKey)
    if (
      payload.type === 'item_started' &&
      ((retained && placement.get(retained)?.completedSnapshot) || old?.firstTerminal !== undefined)
    ) {
      return
    }
    const terminal =
      payload.type === 'item_completed' &&
      ['completed', 'failed', 'declined', 'interrupted'].includes(String(item.status))
    const first =
      old?.firstTerminal ?? (terminal && turn?.complete ? descriptor.ordinal : undefined)
    const { started_at_ms: start, completed_at_ms: end } = payload
    const newlyInterrupted = codexHistoryStartupInterrupted(item, { interval, first, start, end })
    const interrupted =
      newlyInterrupted ||
      (old?.interrupted === true && item.status === 'failed' && item.exitCode === -1)
    const body = yield* history.projectCodexHistoryItemWork(item, null, interrupted)
    if (item.type === 'commandExecution') {
      yield* rememberWork(key, { firstTerminal: first, interrupted, turnKey })
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
      body: withJournalReasoningLifecycle(body, endedJournalReasoning()),
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
      yield* rememberWork(turnKey, { turn })
      yield* turnRowWork(turn)
    }
    yield* storeWork(
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
  }
}
