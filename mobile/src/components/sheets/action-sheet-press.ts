import { useRef, type ReactNode } from 'react'
import type { ActionSheetAction } from './ActionSheetContent'

/** Row presses for a native action sheet; a closeBeforePress action waits for `flush` after dismissal. */
export function useActionSheetPress(onClose: () => void) {
  const pending = useRef<(() => void) | null>(null)
  return {
    press(action: ActionSheetAction) {
      if (action.closeBeforePress) {
        pending.current = action.onPress
      } else {
        action.onPress()
      }
      if (!action.skipAutoClose) {
        onClose()
      }
    },
    flush() {
      const run = pending.current
      pending.current = null
      run?.()
    }
  }
}

/** Native titles take a string, so a marked title falls back to its spoken name. */
export function actionSheetTitleText(
  title: ReactNode,
  titleAccessibilityLabel: string | undefined
): string | undefined {
  if (typeof title === 'string' || typeof title === 'number') {
    return String(title) || undefined
  }
  return titleAccessibilityLabel
}
