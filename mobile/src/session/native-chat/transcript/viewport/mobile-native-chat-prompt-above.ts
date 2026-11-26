import { isNativeChatPromptRow } from '../../../../../../src/shared/native-chat/native-chat-prompt-row'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'

export function mobileNativeChatPromptAbove(
  rows: readonly NativeChatMessage[],
  keys: readonly string[],
  first: number,
  rowOffset: (key: string) => number | undefined
): { key: string; index: number } | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    if (
      !isNativeChatPromptRow(row) ||
      row.queued === true ||
      !row.blocks.some((block) => block.type === 'text' || block.type === 'image-ref')
    ) {
      continue
    }
    const key = keys[index]!
    if (index < first || (rowOffset(key) ?? Infinity) < -8) {
      return { key, index }
    }
  }
  return undefined
}
