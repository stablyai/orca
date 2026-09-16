import type { AgentJournalTurnLifecycle } from '../../shared/agent-session-journal-types'
import type { CodexTurnOrdinals } from './codex-structured-item-translation'
import {
  readCodexJournalRecord,
  readCodexJournalString
} from './codex-structured-journal-translation-values'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-translation'
import {
  codexTurnLifecycleState,
  codexTurnUserItemId
} from './codex-structured-journal-translation-turns'
import { readCodexTurnDurationMs, readCodexTurnStatus } from './codex-structured-thread-facts'

/** Old providers may return the complete thread from resume. Keep that fallback
 * bounded before admitting any rows to the asynchronous sink. */
export const CODEX_RESTORE_MAX_OPERATIONS = 1_024
export const CODEX_RESTORE_MAX_BYTES = 16 * 1024 * 1024

export function restoreCodexJournalThread(input: {
  threadId: string
  thread: Record<string, unknown>
  currentTurnIds: Map<string, Set<string>>
  ordinals: CodexTurnOrdinals
  handleItem: (event: {
    threadId: string
    method: string
    params: unknown
  }) => CodexJournalTranslationAdmission
  /** Absent when the caller has no session identity to key lifecycle rows by. */
  restoreTurnLifecycle?: (
    turnLifecycle: AgentJournalTurnLifecycle
  ) => CodexJournalTranslationAdmission
  flush: () => void
}): CodexJournalTranslationAdmission {
  const turns = Array.isArray(input.thread.turns) ? input.thread.turns : []
  const items = turns.flatMap((rawTurn) => {
    const turn = readCodexJournalRecord(rawTurn)
    const turnId = readCodexJournalString(turn, 'id')
    return turnId
      ? (Array.isArray(turn.items) ? turn.items : []).map((item) => ({ turnId, item }))
      : []
  })
  const lifecycles = input.restoreTurnLifecycle
    ? turns.flatMap(
        (rawTurn) => historicalTurnLifecycle(input.threadId, readCodexJournalRecord(rawTurn)) ?? []
      )
    : []
  const encodedBytes = Buffer.byteLength(JSON.stringify(items), 'utf8')
  if (
    items.length + lifecycles.length > CODEX_RESTORE_MAX_OPERATIONS ||
    encodedBytes > CODEX_RESTORE_MAX_BYTES
  ) {
    return { accepted: false, reason: 'backpressure' }
  }
  for (const rawTurn of turns) {
    const turn = readCodexJournalRecord(rawTurn)
    const turnId = readCodexJournalString(turn, 'id')
    if (!turnId) {
      continue
    }
    input.currentTurnIds.set(input.threadId, new Set([turnId]))
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      const admission = input.handleItem({
        threadId: input.threadId,
        method: 'item/completed',
        params: { turnId, item }
      })
      if (!admission.accepted) {
        return admission
      }
    }
    input.currentTurnIds.delete(input.threadId)
    input.ordinals.forgetTurn(input.threadId, turnId)
    const lifecycle = input.restoreTurnLifecycle
      ? historicalTurnLifecycle(input.threadId, turn)
      : null
    if (lifecycle) {
      const admission = input.restoreTurnLifecycle?.(lifecycle) ?? { accepted: true }
      if (!admission.accepted) {
        return admission
      }
    }
  }
  input.flush()
  return { accepted: true }
}

/** Codex reports both endpoints in unix seconds; a turn missing either has no durable duration. */
function historicalTurnLifecycle(
  threadId: string,
  turn: Record<string, unknown>
): AgentJournalTurnLifecycle | null {
  const turnId = readCodexJournalString(turn, 'id')
  const startedAt = turn.startedAt
  const completedAt = turn.completedAt
  if (
    !turnId ||
    typeof startedAt !== 'number' ||
    typeof completedAt !== 'number' ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt)
  ) {
    return null
  }
  const durationMs = readCodexTurnDurationMs(turn)
  return {
    turnId,
    state: codexTurnLifecycleState(readCodexTurnStatus(turn)),
    userItemId: codexTurnUserItemId(threadId, turnId),
    startedAt: startedAt * 1000,
    completedAt: completedAt * 1000,
    ...(durationMs !== null ? { durationMs } : {})
  }
}
