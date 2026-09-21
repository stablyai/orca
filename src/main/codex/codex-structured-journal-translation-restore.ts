import type { CodexTurnOrdinals } from './codex-structured-item-translation'
import {
  readCodexJournalRecord,
  readCodexJournalString
} from './codex-structured-journal-translation-values'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-translation'

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
  const encodedBytes = Buffer.byteLength(JSON.stringify(items), 'utf8')
  if (items.length > CODEX_RESTORE_MAX_OPERATIONS || encodedBytes > CODEX_RESTORE_MAX_BYTES) {
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
  }
  input.flush()
  return { accepted: true }
}
