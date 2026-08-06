import { createContext, useContext, type ReactNode } from 'react'
import { Modal } from 'react-native'

const BottomDrawerModalHostContext = createContext(false)

/** True when a BottomDrawer is rendered inside a shared BottomDrawerModalHost and
 *  must therefore skip its own native Modal (the host owns the single Modal). */
export function useInsideBottomDrawerModalHost(): boolean {
  return useContext(BottomDrawerModalHostContext)
}

type Props = {
  visible: boolean
  onRequestClose: () => void
  children: ReactNode
}

// Why: iOS cannot reliably dismiss one native modal and present another in the same
// beat. Flows that swap between sibling drawer modals (e.g. the Create Workspace form
// → its repository/agent pickers) dropped the incoming modal, leaving the sheet dead
// to taps. Hosting every drawer in ONE persistent native Modal makes those swaps
// in-window view changes instead, so no present/dismiss race can eat the transition.
export function BottomDrawerModalHost({ visible, onRequestClose, children }: Props) {
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
        {children}
      </BottomDrawerModalHostContext.Provider>
    </Modal>
  )
}
