import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { Modal } from 'react-native'
import { BottomDrawerModalHostContext } from './bottom-drawer-modal-host-scope'

type Props = {
  /** Omit to show the host while any drawer inside is requested, shown or closing. */
  visible?: boolean
  /** Omit to hand Back to the drawer that claimed it last. */
  onRequestClose?: () => void
  children: ReactNode
}

// Why: iOS cannot reliably dismiss one native modal and present another in the same
// beat, and refuses outright to present one while a sibling is presented. Flows that
// swap or stack sibling drawer modals (e.g. the Create Workspace form → its pickers, or
// an issue detail → Create Workspace) dropped the incoming modal, leaving the sheet
// dead to taps. Hosting every drawer in ONE native Modal makes those swaps and stacks
// in-window view changes instead, ordered by zIndex.
export function BottomDrawerModalHost({ visible, onRequestClose, children }: Props) {
  const [holds, setHolds] = useState(0)
  const backClaims = useRef<(() => void)[]>([])
  const hold = useCallback(() => {
    let held = true
    setHolds((count) => count + 1)
    return () => {
      if (held) {
        held = false
        setHolds((count) => count - 1)
      }
    }
  }, [])
  const claimBack = useCallback((dismiss: () => void) => {
    const claim = () => dismiss()
    backClaims.current.push(claim)
    return () => {
      backClaims.current = backClaims.current.filter((entry) => entry !== claim)
    }
  }, [])
  const selfShowing = visible === undefined
  const shown = selfShowing ? holds > 0 : visible
  const scope = useMemo(
    () => ({ shown, hold: selfShowing ? hold : null, claimBack }),
    [shown, selfShowing, hold, claimBack]
  )
  const content = (
    <BottomDrawerModalHostContext.Provider value={scope}>
      {children}
    </BottomDrawerModalHostContext.Provider>
  )

  if (!shown) {
    // Why: a self-showing host keeps its drawers mounted while down so a request can raise it.
    // They remount inside the Modal, which is safe because none of them is showing anything yet.
    return selfShowing ? content : null
  }
  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onRequestClose ?? (() => backClaims.current.at(-1)?.())}
    >
      {content}
    </Modal>
  )
}
