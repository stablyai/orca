import { nativeChatQueueFollowUps } from '../../../../shared/native-chat/input/composer/native-chat-follow-up-behavior'
import { nativeChatShowsCiResultLines } from '../../../../shared/native-chat/native-chat-appearance-settings'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

type PushedPreference = {
  resolve: (settings: {
    readonly nativeChatQueueFollowUps?: unknown
    readonly nativeChatCiResultLines?: unknown
  }) => boolean
  event: (value: boolean) => RuntimeClientEvent
}

// The chat preferences paired clients follow live; each emits only on its own flips.
const PUSHED_PREFERENCES: readonly PushedPreference[] = [
  {
    resolve: nativeChatQueueFollowUps,
    event: (queueFollowUps) => ({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps })
  },
  {
    resolve: nativeChatShowsCiResultLines,
    event: (ciResultLines) => ({ type: 'nativeChatCiResultLinesChanged', ciResultLines })
  }
]

export function publishNativeChatPreferenceChanges(
  store: Pick<RuntimeStore, 'getSettings' | 'onSettingsChanged'> | null,
  emit: (event: RuntimeClientEvent) => void
): void {
  if (!store?.getSettings || !store.onSettingsChanged) {
    return
  }
  const settings = store.getSettings()
  const previous = PUSHED_PREFERENCES.map((preference) => preference.resolve(settings))
  store.onSettingsChanged((_updates, next) => {
    PUSHED_PREFERENCES.forEach((preference, index) => {
      const value = preference.resolve(next)
      if (value !== previous[index]) {
        previous[index] = value
        emit(preference.event(value))
      }
    })
  })
}
