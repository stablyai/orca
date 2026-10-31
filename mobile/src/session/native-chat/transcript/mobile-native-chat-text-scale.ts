import AsyncStorage from '@react-native-async-storage/async-storage'
import { quantizeFontScale } from './mobile-native-chat-message-text'

export const NATIVE_CHAT_TEXT_SCALE_KEY = 'orca:nativeChatTextScale'

// Leaving chat unmounts the view, so the pinched size has to outlive that screen.
let remembered = 1
let pinchCommitted = false

export function readRememberedNativeChatTextScale(): number {
  return remembered
}

export function commitNativeChatTextScale(scale: number): void {
  const next = quantizeFontScale(scale)
  pinchCommitted = true
  if (next === remembered) {
    return
  }
  remembered = next
  void AsyncStorage.setItem(NATIVE_CHAT_TEXT_SCALE_KEY, String(next)).catch(() => {})
}

export async function hydrateNativeChatTextScale(): Promise<number> {
  if (pinchCommitted) {
    return remembered
  }
  try {
    const raw = await AsyncStorage.getItem(NATIVE_CHAT_TEXT_SCALE_KEY)
    if (pinchCommitted) {
      return remembered
    }
    const parsed = raw === null ? Number.NaN : Number(raw)
    if (!Number.isFinite(parsed)) {
      return remembered
    }
    remembered = quantizeFontScale(parsed)
    return remembered
  } catch {
    return remembered
  }
}
