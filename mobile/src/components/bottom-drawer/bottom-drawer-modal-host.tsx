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

// Host swapping/stacked drawers in one native Modal ordered by zIndex: iOS cannot reliably dismiss/present in same beat or present over sibling modal.
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
    // Keep hidden self-showing drawers mounted so requests can raise host; remount inside Modal is safe before they show content.
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
