import { subscribeNativeChatTranscript } from './transcript-watch'
import type { NativeChatTranscriptSubscription } from './transcript-watch-contract'

const subscriptions = new Set<NativeChatTranscriptSubscription>()

export async function subscribeNativeChatTranscriptForTest(
  ...args: Parameters<typeof subscribeNativeChatTranscript>
): Promise<NativeChatTranscriptSubscription> {
  const subscription = await subscribeNativeChatTranscript(...args)
  subscriptions.add(subscription)
  return subscription
}

export function closeNativeChatTestSubscriptions(): void {
  for (const subscription of subscriptions) {
    subscription.unsubscribe()
  }
  subscriptions.clear()
}
