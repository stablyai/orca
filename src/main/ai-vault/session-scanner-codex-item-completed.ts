// AI Vault handling for Codex Paginated-history `item_completed` TurnItems.
// Kept separate from the main line fold so session-scanner-codex-parser stays
// under the max-lines budget while still counting messages for previews.

import { addPreviewContent } from './session-scanner-accumulator'
import type { SessionAccumulator } from './session-scanner-types'
import { asRecord, extractContentText, extractString } from './session-scanner-values'

export type CodexItemCompletedState = {
  accumulator: SessionAccumulator
  titleSource: 'meta' | 'user' | null
}

export function consumeCodexItemCompleted(
  state: CodexItemCompletedState,
  payload: Record<string, unknown>,
  timestamp: unknown
): void {
  const item = asRecord(payload.item)
  if (!item) {
    return
  }
  const itemType = normalizeCodexTurnItemType(item.type)
  const { accumulator } = state

  if (itemType === 'user_message') {
    const text = extractContentText(item.content)
    accumulator.messageCount++
    if (!accumulator.title && text) {
      accumulator.title = text
      state.titleSource = 'user'
    }
    addPreviewContent(accumulator, 'user', item.content, timestamp)
    return
  }

  if (itemType === 'agent_message') {
    accumulator.messageCount++
    addPreviewContent(accumulator, 'assistant', item.content, timestamp)
  }
}

/** Normalize TurnItem wire tags (snake_case or PascalCase) to snake_case. */
function normalizeCodexTurnItemType(value: unknown): string | null {
  const raw = extractString(value)
  if (!raw) {
    return null
  }
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}
