import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'
import { journalPayload } from '../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import type { CodexHistoryRecord } from '../native-chat/transcript-history/codex/codex-local-history'
import { readRecord, readString } from '../codex/app-server/codex-item-field-readers'
import { createCodexHistoryCollector } from '../native-chat/agent-session-journal/history-import/journal-codex-history'
import type { JournalPayloadLimits } from '../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import { codexTurnLifecycleIdentity } from '../codex/structured/journal/codex-structured-journal-translation-turns'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'

const ARCHIVED_DETAIL = 'Historical details are retained in the original TRAE CLI session log.'

export function scopeTraeHistoryRecord(descriptor: CodexHistoryRecord): CodexHistoryRecord {
  const record = descriptor.record
  const payload = readRecord(record?.payload)
  const item = readRecord(payload.item)
  const turnId = readString(payload, 'turn_id')
  const itemId = readString(item, 'id')
  if (record?.type !== 'event_msg' || !turnId || !itemId) {
    return descriptor
  }
  const id = `${turnId}:${itemId}`
  return {
    ...descriptor,
    recordId: `${descriptor.segmentId}:${id}`,
    record: { ...record, payload: { ...payload, item: { ...item, id } } }
  }
}

export function createTraeHistoryCollector(
  sessionId: string,
  limits: JournalPayloadLimits,
  maxBytes: number
) {
  const retained = createCodexHistoryCollector(
    sessionId,
    limits,
    maxBytes * 2,
    projectTraeImportedHistory
  )
  const active: string[] = []
  const known = new Set<string>()
  const removed = new Set<string>()
  const rollback = (index: number) => {
    for (const id of active.splice(index)) {
      removed.add(agentJournalItemKey(codexTurnLifecycleIdentity(sessionId, id)))
    }
  }
  return {
    push: retained.push,
    record(descriptor: CodexHistoryRecord) {
      const record = descriptor.record
      const payload = readRecord(record?.payload)
      const turnId = readString(payload, 'turn_id')
      if (record?.type === 'event_msg' && turnId && !known.has(turnId)) {
        known.add(turnId)
        active.push(turnId)
      }
      if (record?.type === 'history_mutation' && payload.operation === 'rollback') {
        const target = readString(payload, 'target_turn_id')
        const index = target === null ? -1 : active.indexOf(target)
        if (index >= 0) {
          rollback(index)
        }
      }
      if (record?.type === 'event_msg' && payload.type === 'thread_rolled_back') {
        const count = payload.num_turns
        if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0) {
          rollback(Math.max(0, active.length - count))
        }
      }
      retained.record(scopeTraeHistoryRecord(descriptor))
    },
    items: () =>
      retained
        .items()
        .filter((row) =>
          row.body.kind === 'turn'
            ? !removed.has(agentJournalItemKey(row.identity))
            : row.turnScope?.kind !== 'turn' || !removed.has(row.turnScope.turnItemId)
        )
  }
}

export function projectTraeImportedHistory(body: AgentJournalItemBody): AgentJournalItemBody {
  if (body.kind === 'message') {
    return body.role === 'user' || body.role === 'assistant'
      ? body
      : { ...body, blocks: [{ type: 'text', text: ARCHIVED_DETAIL }] }
  }
  if (body.kind === 'tool-call') {
    return {
      kind: 'tool-call',
      name: body.name,
      input: {},
      callId: body.callId,
      state: body.state,
      output: journalPayload(ARCHIVED_DETAIL)
    }
  }
  if (body.kind === 'diff') {
    return { ...body, patch: journalPayload(ARCHIVED_DETAIL) }
  }
  return body
}
