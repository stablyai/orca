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

export function triggerSelection(): void {
  if (Platform.OS === 'android') {
    void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Gesture_Start).catch(() => {})
  } else {
    void Haptics.selectionAsync().catch(() => {})
  }
}

export function triggerSuccess(): void {
  if (Platform.OS === 'android') {
    void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Confirm).catch(() => {})
  } else {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
  }
}

export function triggerError(): void {
  if (Platform.OS === 'android') {
    void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Reject).catch(() => {})
  } else {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {})
  }
}

export function triggerEdgeBump(): void {
  if (Platform.OS === 'android') {
    void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Clock_Tick).catch(() => {})
  } else {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
  }
}
