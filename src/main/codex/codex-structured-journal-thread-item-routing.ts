// Where one `item/started` or `item/completed` notification goes: the subagent
// roster, the typed item translator, or the generic fallback — and, when the item
// is Codex echoing a send back, the turn attribution that echo unlocks.

import type { CodexJournalGenericFrames } from './codex-structured-journal-generic-frames'
import type { CodexJournalItems } from './codex-structured-journal-items'
import type {
  CodexJournalTranslationAdmission,
  CodexJournalTranslatorDeps
} from './codex-structured-journal-contracts'
import type { CodexJournalActiveTurns } from './codex-structured-journal-translation-turn-state'
import type { CodexJournalTurnBoundaries } from './codex-structured-journal-translation-turn-boundaries'
import { readCodexThreadItem } from './codex-structured-item-translation'
import { readCodexNotificationThreadItem } from './codex-subagent-activity'
import type { CodexSubagentRoster } from './codex-subagent-roster'
import { readCodexTurnId } from './codex-structured-thread-facts'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

type ThreadItemEvent = Extract<CodexStructuredSessionEvent, { type: 'notification' }>

/** Null means no arm claimed the item; the caller falls back to a generic row. */
export type CodexThreadItemRouting = CodexJournalTranslationAdmission | null

export function createCodexThreadItemRouter(input: {
  deps: Pick<CodexJournalTranslatorDeps, 'dispatchRequestOrigin' | 'onUserMessageEcho'>
  subagents: Pick<CodexSubagentRoster, 'handleItem'>
  items: Pick<CodexJournalItems, 'handle'>
  activeTurns: Pick<CodexJournalActiveTurns, 'current'>
  turnBoundaries: Pick<CodexJournalTurnBoundaries, 'attributeRequest'>
  genericFrames: Pick<CodexJournalGenericFrames, 'appendUnhandled'>
}): (event: ThreadItemEvent) => CodexThreadItemRouting {
  return (event) => {
    const subagentItem = readCodexNotificationThreadItem(event.params, readCodexThreadItem)
    // Null means the roster did not claim it; fall through to normal item
    // handling. Returning here unconditionally swallows every other item.
    const subagentAdmission = subagentItem
      ? input.subagents.handleItem({
          threadId: event.threadId,
          turnId: readCodexTurnId(event.params) ?? input.activeTurns.current(event.threadId),
          item: subagentItem
        })
      : null
    if (subagentAdmission) {
      return subagentAdmission
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
