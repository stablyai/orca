import { nativeChatFollowUpBehavior } from '../../shared/native-chat-follow-up-behavior'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { RuntimeStore } from './runtime-store-contract'

export function publishNativeChatFollowUpChanges(
  store: Pick<RuntimeStore, 'getSettings' | 'onSettingsChanged'> | null,
  emit: (event: RuntimeClientEvent) => void
): void {
  if (!store?.getSettings || !store.onSettingsChanged) {
    return
  }
  let previous = nativeChatFollowUpBehavior(store.getSettings())
  store.onSettingsChanged((_updates, settings) => {
    const behavior = nativeChatFollowUpBehavior(settings)
    if (behavior !== previous) {
      previous = behavior
      emit({ type: 'nativeChatFollowUpBehaviorChanged', behavior })
    }
  })
}
