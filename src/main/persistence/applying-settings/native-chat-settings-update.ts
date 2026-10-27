import { normalizeNativeChatAppearanceSettings } from '../../../shared/native-chat-appearance-settings'
import { normalizeNativeChatSpeechSettings } from '../../../shared/native-chat-speech'
import type { GlobalSettings } from '../../../shared/global-settings-types'

export function applyNativeChatSettingsUpdate(
  sanitizedUpdates: Partial<GlobalSettings>,
  updates: Partial<GlobalSettings>
): void {
  if ('nativeChatAppearance' in updates) {
    sanitizedUpdates.nativeChatAppearance = normalizeNativeChatAppearanceSettings(
      updates.nativeChatAppearance
    )
  }
  if ('nativeChatSpeech' in updates) {
    sanitizedUpdates.nativeChatSpeech = normalizeNativeChatSpeechSettings(updates.nativeChatSpeech)
  }
}
