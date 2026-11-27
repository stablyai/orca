import type { CodexJournalItems } from './codex-structured-journal-items'
import { jsonProperty } from '../../../../shared/json-stream/json-value-property'
import { codexStructuredItemKey } from '../items/codex-structured-item-stream-bounds'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission,
  type CodexJournalTranslatorDeps
} from './codex-structured-journal-contracts'

/**
 * A relay continuation row (an item a cap-cut replay started inside) whose item then ended: the
 * end wrote the whole item to its saved row, so the continuation's own row goes.
 */
export function retireCodexRelayContinuation(
  items: Pick<CodexJournalItems, 'identities'>,
  sink: CodexJournalTranslatorDeps['sink'],
  threadId: string,
  params: unknown
): CodexJournalTranslationAdmission {
  const itemId = jsonProperty(params, 'itemId')
  const key = typeof itemId === 'string' ? codexStructuredItemKey(threadId, itemId) : null
  const identity = key === null ? undefined : items.identities.get(key)
  if (key === null || !identity) {
    return CODEX_JOURNAL_ADMITTED
  }
  // Forgotten, so nothing writes to the retired row again.
  items.identities.delete(key)
  if (!sink.tryAppendTombstone) {
    sink.appendTombstone(identity, { lifecycle: true })
    return CODEX_JOURNAL_ADMITTED
  }
  return sink.tryAppendTombstone(identity, { lifecycle: true })
}
