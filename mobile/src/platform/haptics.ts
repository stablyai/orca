import { Platform } from 'react-native'
import * as Haptics from 'expo-haptics'

export function triggerMediumImpact(): void {
  if (Platform.OS === 'android') {
    // Why: Android's Vibrator API (used by impactAsync) is unreliable for haptic
    // feedback. performAndroidHapticsAsync uses the native HapticFeedbackConstants
    // API which works without VIBRATE permission and feels more natural.
    void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Long_Press).catch(() => {})
  } else {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {})
  }
}
