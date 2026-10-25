import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { normalizeNativeChatUserText as normalizeReconcileText } from '../../../src/shared/native-chat-image-transcript-markers'
import type { MobileNativeChatPendingMessage } from './mobile-native-chat-pending-echo'

// Pin only tail-less text sends on the first settled read; reconnect-retained tails already bound the right history.
// Never recount ordinals or supply image/empty-send tails: the new read may contain their own echo, so rebasing would exclude it forever.
export function rebaseMobileNativeChatPendingBaselines(
  messages: readonly NativeChatMessage[],
  current: MobileNativeChatPendingMessage[]
): MobileNativeChatPendingMessage[] {
  if (current.every((item) => item.baselineResolved)) {
    return current
  }
  const baselineTailMessageId = messages.at(-1)?.id ?? null
  return current.map((item) => {
    if (item.baselineResolved) {
      return item
    }
    const reconcilesAgainstItsOwnTail =
      Boolean(item.images?.length) || normalizeReconcileText(item.text) === ''
    return item.baselineTailMessageId !== null || reconcilesAgainstItsOwnTail
      ? { ...item, baselineResolved: true }
      : { ...item, baselineResolved: true, baselineTailMessageId }
  })
}
