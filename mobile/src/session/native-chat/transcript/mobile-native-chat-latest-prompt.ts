import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'

export function mobileNativeChatLatestPrompt(
  rows: readonly NativeChatMessage[]
): NativeChatMessage | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!
    if (
      row.role !== 'user' ||
      row.queued === true ||
      row.stoppedBeforeStart === true ||
      row.agentStart === true ||
      !row.blocks.some((block) => block.type === 'text' || block.type === 'image-ref')
    ) {
      continue
    }
    const unconfirmed =
      row.pendingSend !== undefined ||
      row.deliveryState !== undefined ||
      row.unsent ||
      row.awaitsRetry
    return unconfirmed ? null : row
  }
  return null
}
