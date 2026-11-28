import { useContext } from 'react'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SESSION_LIST_LONG_PRESS_MS } from './session-list-back'
import { SessionListLongPressContext } from './session-list-long-press-context'

export function useSessionListLongPressAction(): (() => void) | null {
  return useContext(SessionListLongPressContext)
}

type AccessibilityActionEvent = { nativeEvent: { actionName: string } }

export function useSessionListLongPressProps(onLongPress?: () => void): {
  onLongPress?: () => void
  delayLongPress?: number
  accessibilityHint?: string
  accessibilityActions?: { name: string; label: string }[]
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void
} {
  const fromHost = useSessionListLongPressAction()
  const t = useMobileTranslation()
  const go = onLongPress ?? fromHost ?? undefined
  if (!go) {
    return {}
  }
  const label = t('navigation.sessionListBack.action', 'Back to sessions')
  return {
    onLongPress: go,
    delayLongPress: SESSION_LIST_LONG_PRESS_MS,
    accessibilityHint: t('navigation.sessionListBack.hint', 'Long press to go back to sessions'),
    accessibilityActions: [{ name: 'longpress', label }],
    onAccessibilityAction: (event) => {
      if (event.nativeEvent.actionName === 'longpress') {
        go()
      }
    }
  }
}
