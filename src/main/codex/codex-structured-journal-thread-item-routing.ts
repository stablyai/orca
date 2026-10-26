import type { CodexJournalGenericFrames } from './codex-structured-journal-generic-frames'
import type { CodexJournalItems } from './codex-structured-journal-items'
import type {
  CodexJournalTranslationAdmission,
  CodexJournalTranslatorDeps
} from './codex-structured-journal-contracts'
import type { CodexJournalTurnBoundaries } from './codex-structured-journal-translation-turn-boundaries'
import { readCodexThreadItem } from './codex-structured-item-translation'
import {
  readCodexNotificationThreadItem,
  readCodexSubagentActivity
} from './codex-subagent-activity'
import { CODEX_JOURNAL_ADMITTED } from './codex-structured-journal-contracts'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

type ThreadItemEvent = Extract<CodexStructuredSessionEvent, { type: 'notification' }>

/** Null means no arm claimed the item; the caller falls back to a generic row. */
export type CodexThreadItemRouting = CodexJournalTranslationAdmission | null

export function createCodexThreadItemRouter(input: {
  deps: Pick<CodexJournalTranslatorDeps, 'dispatchRequestOrigin' | 'onUserMessageEcho'>
  items: Pick<CodexJournalItems, 'handle'>
  turnBoundaries: Pick<CodexJournalTurnBoundaries, 'attributeRequest'>
  genericFrames: Pick<CodexJournalGenericFrames, 'appendUnhandled'>
}): (event: ThreadItemEvent) => CodexThreadItemRouting {
  return (event) => {
    const subagentItem = readCodexNotificationThreadItem(event.params, readCodexThreadItem)
    // The host records child activity; duplicating it here would create extra rows.
    if (subagentItem && readCodexSubagentActivity(subagentItem) !== null) {
      return CODEX_JOURNAL_ADMITTED
    }
    const translated = input.items.handle(event)
    if (translated.handled && translated.dispatchEcho) {
      const { clientMessageId, providerIdentity } = translated.dispatchEcho
      const requestOrigin = input.deps.dispatchRequestOrigin?.(clientMessageId) ?? null
      if (requestOrigin !== null && providerIdentity.provider === 'codex') {
        const attribution = input.turnBoundaries.attributeRequest({
          sessionId: event.sessionId,
          clientMessageId,
          threadId: providerIdentity.threadId,
          turnId: providerIdentity.turnId,
          requestOrigin
        })
        if (!attribution.accepted) {
          return attribution
        }
      }
      input.deps.onUserMessageEcho?.(clientMessageId, providerIdentity)
    }
    return translated.handled
      ? translated.admission
      : input.genericFrames.appendUnhandled(
          `notification:${event.method}`,
          event.params,
          event.threadId
        )
  }
}
