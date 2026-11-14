import { useEffect, useRef } from 'react'

export function useBottomDrawerFollowUp(close: () => void) {
  const pending = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      pending.current = null
    },
    []
  )
  return {
    closeThen(action: () => void) {
      pending.current = action
      close()
    },
    drawerProps: {
      onClose: close,
      onAfterClose() {
        const action = pending.current
        pending.current = null
        action?.()
      }
    }
  }
}
