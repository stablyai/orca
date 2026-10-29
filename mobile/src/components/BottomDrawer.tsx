import type { ReactNode } from 'react'
import { KeyedBottomDrawer } from './keyed-bottom-drawer'

type Props = {
  visible: boolean
  onClose: () => void
  onAfterClose?: () => void
  children: ReactNode
  dragContentToDismiss?: boolean
  contentScrollable?: boolean
  // Stable outer frame keeps docked input above keyboard while results reflow; content-sized sheets move it on every list change.
  fillAvailable?: boolean
  // Pin outer sheet under fill picker without extra touches, backdrop or keyboard lift.
  interactive?: boolean
  zIndex?: number
  scrollResetKey?: string | null
}

const SHOWN = 'shown'
const sheetKey = () => SHOWN

export function BottomDrawer({ visible, onClose, onAfterClose, children, ...drawerProps }: Props) {
  // Closed drawers render nothing to avoid Reanimated/Gesture setup in hot paths even when parent mounts them.
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
