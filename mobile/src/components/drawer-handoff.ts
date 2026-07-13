import { useEffect, useRef } from 'react'
import { BOTTOM_DRAWER_HIDE_DURATION_MS } from './bottom-drawer-constants'

export type DrawerHandoff = {
  run: (openNext: () => void) => void
  dispose: () => void
}

// Why: each BottomDrawer is its own native <Modal>, and presenting a second one
// while the first is still animating out strands two iOS modals and freezes the
// app (issue #8555). Defer the follow-up until the closing drawer's hide
// animation finishes so only one Modal is ever mounted.
export function createDrawerHandoff(
  hideDurationMs: number = BOTTOM_DRAWER_HIDE_DURATION_MS
): DrawerHandoff {
  let pending: ReturnType<typeof setTimeout> | null = null

  const dispose = (): void => {
    if (pending !== null) {
      clearTimeout(pending)
      pending = null
    }
  }

  return {
    run(openNext) {
      // Why: supersede a queued follow-up so a rapid second tap can't double-open.
      dispose()
      pending = setTimeout(() => {
        pending = null
        openNext()
      }, hideDurationMs)
    },
    dispose
  }
}

// Why: cancel any pending follow-up on unmount so a navigated-away screen can't
// pop a stray modal.
export function useDrawerHandoff(): DrawerHandoff['run'] {
  const handoffRef = useRef<DrawerHandoff | null>(null)
  if (handoffRef.current === null) {
    handoffRef.current = createDrawerHandoff()
  }
  useEffect(() => () => handoffRef.current?.dispose(), [])
  return handoffRef.current.run
}
