import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { normalizeReconcileText } from './mobile-native-chat-draft-reconcile'
import type { MobileNativeChatPendingMessage } from './mobile-native-chat-pending-echo'

/**
 * Give the sends that never saw a transcript the boundary they lack, on the
 * first settled read.
 *
 * Such a send has no row to judge candidates against — which held it out of
 * matching entirely, stranding it as a queued bubble and, worse, as a permanent
 * glue barrier for its neighbours.
 *
 * Only a send that captured NO tail is pinned. An unsettled read still shows
 * this session's own retained history (see `createNativeChatTranscriptRetention`
 * — a reconnect or a failed read keeps the conversation on screen rather than
 * blanking it), so a send made then already owns a correct boundary. Moving it
 * onto this read would push it past the send's own echo and strand the bubble
 * for good.
 *
 * The ordinal is deliberately NOT recounted. The read can already carry the
 * send's own echo — a re-subscribe returns whatever exists now — and nothing
 * local separates that echo from an identical older prompt: the transport writes
 * keystrokes into a TUI and carries no message id, and row timestamps come from
 * the host while the send time comes from the phone. Counting it as history puts
 * the ordinal one past anything the transcript can supply.
 *
 * And only a TEXT-bearing send is given one. The glue matcher is the sole
 * consumer that a supplied tail helps; every other one is harmed by it. An image
 * echo reconciles by counting turns AFTER its tail, so a tail taken from a read
 * that already carries its echo excludes that echo and the bubble can never
 * retire — image entries have no other retirement path. A captioned one is worse
 * still: it binds by an ordinal counted over the whole transcript, so a tail
 * without a matching recount leaves it claiming nothing at all.
 */
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
