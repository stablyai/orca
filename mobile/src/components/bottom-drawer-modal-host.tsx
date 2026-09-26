import { createContext, useContext, type ReactNode } from 'react'
import { Modal } from 'react-native'
import {
  BottomDrawerHostAfterCloseContext,
  BottomDrawerHostCloseCancelledContext
} from './bottom-drawer-host-after-close'

const BottomDrawerModalHostContext = createContext(false)

/** True when a BottomDrawer is rendered inside a shared BottomDrawerModalHost and
 *  must therefore skip its own native Modal (the host owns the single Modal). */
export function useInsideBottomDrawerModalHost(): boolean {
  return useContext(BottomDrawerModalHostContext)
}

type Props = {
  visible: boolean
  onRequestClose: () => void
  onChildAfterClose?: () => void
  onChildCloseCancelled?: () => void
  children: ReactNode
}

// Why: iOS cannot reliably dismiss one native modal and present another in the same
// beat. Flows that swap between sibling drawer modals (e.g. the Create Workspace form
// → its repository/agent pickers) dropped the incoming modal, leaving the sheet dead
// to taps. Hosting every drawer in ONE persistent native Modal makes those swaps
// in-window view changes instead, so no present/dismiss race can eat the transition.
export function BottomDrawerModalHost({
  visible,
  onRequestClose,
  onChildAfterClose,
  onChildCloseCancelled,
  children
}: Props) {
  if (!visible) {
    return null
  }
  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onRequestClose}
    >
      <BottomDrawerModalHostContext.Provider value={true}>
        <BottomDrawerHostCloseCancelledContext.Provider value={onChildCloseCancelled ?? null}>
          <BottomDrawerHostAfterCloseContext.Provider value={onChildAfterClose ?? null}>
            {children}
          </BottomDrawerHostAfterCloseContext.Provider>
        </BottomDrawerHostCloseCancelledContext.Provider>
      </BottomDrawerModalHostContext.Provider>
    </Modal>
  )
}
