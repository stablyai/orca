import { Platform } from 'react-native'
import * as Haptics from 'expo-haptics'

export function triggerMediumImpact(): void {
  if (Platform.OS === 'android') {
    // Use Android HapticFeedbackConstants without VIBRATE permission; impactAsync’s Vibrator API is unreliable for feedback.
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
