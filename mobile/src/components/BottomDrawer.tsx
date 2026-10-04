import type { ReactNode } from 'react'
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
  // Why: hidden drawers are rendered by parent screens even while closed; the keyed drawer
  // renders nothing until shown, which keeps Reanimated/Gesture setup out of hot paths.
  return (
    <KeyedBottomDrawer
      {...drawerProps}
      sheet={visible ? SHOWN : null}
      sheetKey={sheetKey}
      onClose={onClose}
      onAfterClose={onAfterClose}
    >
      {() => children}
    </KeyedBottomDrawer>
  )
}
