import { useRef, type Dispatch, type SetStateAction } from 'react'

type BottomDrawerCloseProps = {
  onClose: () => void
  onAfterClose: () => void
}

export type BottomDrawerFollowUp = {
  /** Close the drawer, then run `followUp` once its native window is gone. */
  closeThen: (followUp: () => void) => void
  /** Spread onto the drawer whose close the follow-up waits for. */
  drawerProps: BottomDrawerCloseProps
}

// Why: a drawer is a native iOS modal, and one presented while another is still
// on screen is dropped — the source sheet stays up and the screen goes dead to
// taps. An action that opens a second drawer has to wait out the close of the
// drawer it was launched from.
export function createBottomDrawerFollowUp(close: () => void): BottomDrawerFollowUp {
  let pending: (() => void) | null = null
  return {
    closeThen(followUp) {
      pending = followUp
      close()
    },
    drawerProps: {
      onClose: close,
      onAfterClose() {
        const followUp = pending
        pending = null
        followUp?.()
      }
    }
  }
}

export function useBottomDrawerFollowUp<T>(
  setDrawer: Dispatch<SetStateAction<T | null>>
): BottomDrawerFollowUp {
  // Why: state setters are stable, so one follow-up outlives every render.
  const followUp = useRef<BottomDrawerFollowUp | null>(null)
  if (!followUp.current) {
    followUp.current = createBottomDrawerFollowUp(() => setDrawer(null))
  }
  return followUp.current
}
