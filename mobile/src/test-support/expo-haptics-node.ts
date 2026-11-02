// Alias the native-only haptics module to silent no-ops for Vitest, so shared controls that tick need no per-test mock.
const done = (): Promise<void> => Promise.resolve()

export const impactAsync = done
export const selectionAsync = done
export const notificationAsync = done
export const performAndroidHapticsAsync = done

export const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy' } as const
export const NotificationFeedbackType = {
  Success: 'success',
  Warning: 'warning',
  Error: 'error'
} as const
export const AndroidHaptics = {
  Long_Press: 'long-press',
  Gesture_Start: 'gesture-start',
  Confirm: 'confirm',
  Reject: 'reject',
  Clock_Tick: 'clock-tick'
} as const
