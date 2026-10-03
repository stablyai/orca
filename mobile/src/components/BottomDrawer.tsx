import { type ReactNode, useCallback, useEffect, useRef } from 'react'
import {
  useBottomDrawerHostAfterClose,
  useBottomDrawerHostCloseStarted,
  useBottomDrawerHostCloseCancelled
} from './bottom-drawer-host-after-close'
import { KeyedBottomDrawer } from './keyed-bottom-drawer'

type Props = {
  visible: boolean
  onClose: () => void
  onAfterClose?: () => void
  children: ReactNode
  dragContentToDismiss?: boolean
  contentScrollable?: boolean
  // Why: smart-source (and similar) need a stable outer frame so a docked
  // TextInput can sit above the keyboard while results reflow in flex space
  // above it — content-sized sheets make that field ride every list change.
  fillAvailable?: boolean
  // Why: pin an outer content-sized sheet under an inner fill picker without
  // letting it take touches, draw a second backdrop, or keyboard-lift.
  interactive?: boolean
  zIndex?: number
}

const SHOWN = 'shown'
const sheetKey = () => SHOWN

export function BottomDrawer({ visible, onClose, onAfterClose, children, ...drawerProps }: Props) {
  const hostAfterClose = useBottomDrawerHostAfterClose()
  const hostCloseStarted = useBottomDrawerHostCloseStarted()
  const hostCloseCancelled = useBottomDrawerHostCloseCancelled()
  const visibleRef = useRef(visible)
  const closePendingRef = useRef(false)
  useEffect(() => {
    if (visibleRef.current && !visible) {
      closePendingRef.current = true
      hostCloseStarted?.()
    } else if (!visibleRef.current && visible && closePendingRef.current) {
      // The keyed drawer cancels this hide; balance the host without waiting for onHidden.
      closePendingRef.current = false
      hostCloseCancelled?.()
    }
    visibleRef.current = visible
  }, [visible, hostCloseStarted, hostCloseCancelled])
  const handleAfterClose = useCallback(() => {
    closePendingRef.current = false
    onAfterClose?.()
    hostAfterClose?.()
  }, [onAfterClose, hostAfterClose])
  // Why: hidden drawers are rendered by parent screens even while closed; the keyed drawer
  // renders nothing until shown, which keeps Reanimated/Gesture setup out of hot paths.
  return (
    <KeyedBottomDrawer
      {...drawerProps}
      sheet={visible ? SHOWN : null}
      sheetKey={sheetKey}
      onClose={onClose}
      onAfterClose={handleAfterClose}
    >
      {() => children}
    </KeyedBottomDrawer>
  )
}
