import type { AgentJournalTurnLifecycle } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import '../items/codex-structured-item-translation'
import { readCodexThreadItem } from '../items/codex-thread-item-identity'
import type { CodexTurnOrdinals } from './codex-turn-ordinals'
import type { CodexJournalCompactions } from './codex-structured-journal-compactions'
import type { CodexJournalItems } from './codex-structured-journal-items'
import {
  readCodexNotificationThreadItem,
  readCodexSubagentAnnouncements
} from '../background-work/codex-subagent-activity'
import type { CodexSubagentExecutions } from '../background-work/codex-subagent-executions'
import {
  readCodexJournalRecord,
  readCodexJournalString
} from './codex-structured-journal-translation-values'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-contracts'
import {
  codexTurnLifecycleState,
  codexTurnOutcome,
  codexTurnUserItemId
} from './codex-structured-journal-translation-turns'
import {
  readCodexTurnDurationMs,
  readCodexTurnStatus
} from '../../app-server/codex-structured-thread-facts'

type CodexHistoryItemEvent = { threadId: string; method: string; params: unknown }

/** Restore helper names and membership without marking historical helpers as running. */
export function restoreCodexHistoryItem(
  event: CodexHistoryItemEvent,
  input: {
    primaryThreadId: string | null
    compactions: Pick<CodexJournalCompactions, 'handle'>
    items: Pick<CodexJournalItems, 'handle'>
    executions: Pick<CodexSubagentExecutions, 'register'>
  }
): CodexJournalTranslationAdmission {
  const item = readCodexNotificationThreadItem(event.params, readCodexThreadItem)
  const announcements = item ? readCodexSubagentAnnouncements(item, input.primaryThreadId) : []
  for (const announcement of announcements) {
    input.executions.register(announcement.agentThreadId, announcement.label)
  }
  const compaction = input.compactions.handle(event)
  if (compaction) {
    return compaction
  }
  const translated = input.items.handle(event, 'history')
  return translated.handled ? translated.admission : { accepted: false, reason: 'untranslated' }
}

/** Optional history plans are admitted whole within these operation and byte bounds. */
export const CODEX_RESTORE_MAX_OPERATIONS = 1_024
export const CODEX_RESTORE_MAX_BYTES = 16 * 1024 * 1024

export function restoreCodexJournalThread(input: {
  threadId: string
  thread: Record<string, unknown>
  currentTurnIds: Map<string, Set<string>>
  ordinals: CodexTurnOrdinals
  handleItem: (event: CodexHistoryItemEvent) => CodexJournalTranslationAdmission
  /** Requires a session identity to key lifecycle rows. */
  restoreTurnLifecycle?: (
    turnLifecycle: AgentJournalTurnLifecycle
  ) => CodexJournalTranslationAdmission
  flush: () => void
}): CodexJournalTranslationAdmission {
  const turns = Array.isArray(input.thread.turns) ? input.thread.turns : []
  for (const rawTurn of turns) {
    const turn = readCodexJournalRecord(rawTurn)
    const turnId = readCodexJournalString(turn, 'id')
    if (!turnId) {
      continue
    }
    // Readers assign items to the nearest preceding turn record.
    const lifecycle = input.restoreTurnLifecycle
      ? historicalTurnLifecycle(input.threadId, turn)
      : null
    if (lifecycle) {
      const admission = input.restoreTurnLifecycle?.(lifecycle) ?? { accepted: true }
      if (!admission.accepted) {
        return admission
      }
    }
    const admission = restoreTurnItems(input, turnId, turn)
    if (!admission.accepted) {
      return admission
    }
  }
  input.flush()
  return { accepted: true }
}

function restoreTurnItems(
  input: Pick<
    Parameters<typeof restoreCodexJournalThread>[0],
    'threadId' | 'currentTurnIds' | 'ordinals' | 'handleItem'
  >,
  turnId: string,
  turn: Record<string, unknown>
): CodexJournalTranslationAdmission {
  input.currentTurnIds.set(input.threadId, new Set([turnId]))
  try {
    const turnItems = Array.isArray(turn.items) ? turn.items : []
    const review = turnItems.some(
      (item) => readCodexJournalRecord(item).type === 'enteredReviewMode'
    )
    for (const item of turnItems) {
      if (review && readCodexJournalRecord(item).type === 'userMessage') {
        continue
      }
      const admission = input.handleItem({
        threadId: input.threadId,
        method: 'item/completed',
        params: { turnId, item }
      })
      if (!admission.accepted) {
        return admission
      }
    }
    return { accepted: true }
  } finally {
    // A refused row must not leave this turn current for the live turns that follow.
    input.currentTurnIds.delete(input.threadId)
    input.ordinals.forgetTurn(input.threadId, turnId)
  }
}

/** Preserve the turn's status even when its optional timestamps are absent. */
export function historicalTurnLifecycle(
  threadId: string,
  turn: Record<string, unknown>
): AgentJournalTurnLifecycle | null {
  const turnId = readCodexJournalString(turn, 'id')
  if (!turnId) {
    return null
  }
  const startedAt = unixSecondsToMs(turn.startedAt)
  const completedAt = unixSecondsToMs(turn.completedAt)
  const durationMs = readCodexTurnDurationMs(turn)
  const status = readCodexTurnStatus(turn)
  const outcome = codexTurnOutcome(status)
  return {
    turnId,
    state: codexTurnLifecycleState(status),
    ...(outcome ? { outcome } : {}),
    userItemId: codexTurnUserItemId(threadId, turnId),
    ...(startedAt !== null ? { startedAt } : {}),
    ...(completedAt !== null ? { completedAt } : {}),
    ...(durationMs !== null ? { durationMs } : {})
  }
}

function unixSecondsToMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : null
}
