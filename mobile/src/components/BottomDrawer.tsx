import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  useBottomDrawerHostAfterClose,
  useBottomDrawerHostCloseCancelled
} from './bottom-drawer-host-after-close'
import { resolveBottomDrawerMounted } from './bottom-drawer-mount-state'
import { MountedBottomDrawer } from './mounted-bottom-drawer'

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

export function BottomDrawer({
  visible,
  onClose,
  onAfterClose,
  children,
  dragContentToDismiss = true,
  contentScrollable = true,
  fillAvailable = false,
  interactive = true,
  zIndex
}: Props) {
  const [mounted, setMounted] = useState(visible)
  const onAfterCloseRef = useRef(onAfterClose)
  const hostAfterClose = useBottomDrawerHostAfterClose()
  const hostCloseCancelled = useBottomDrawerHostCloseCancelled()
  const hostAfterCloseRef = useRef(hostAfterClose)
  const hostCloseCancelledRef = useRef(hostCloseCancelled)
  const hiddenHandledRef = useRef(false)
  const afterClosePendingRef = useRef(false)
  const visibleRef = useRef(visible)
  const closeInFlightRef = useRef(false)
  hostAfterCloseRef.current = hostAfterClose
  hostCloseCancelledRef.current = hostCloseCancelled

  useEffect(() => {
    onAfterCloseRef.current = onAfterClose
  }, [onAfterClose])

  useEffect(() => {
    const wasVisible = visibleRef.current
    visibleRef.current = visible
    if (wasVisible && !visible) {
      closeInFlightRef.current = true
      return
    }
    if (!wasVisible && visible) {
      const cancelledBeforeHidden = closeInFlightRef.current && !hiddenHandledRef.current
      // onHidden and this reopen can land in one commit, before mounted becomes false.
      const finishedBeforeCommit =
        hiddenHandledRef.current && afterClosePendingRef.current && mounted
      if (cancelledBeforeHidden || finishedBeforeCommit) {
        hostCloseCancelledRef.current?.()
      }
      closeInFlightRef.current = false
      hiddenHandledRef.current = false
      afterClosePendingRef.current = false
    }
  }, [mounted, visible])

  useEffect(() => {
    if (mounted || !afterClosePendingRef.current) {
      return
    }
    afterClosePendingRef.current = false
    onAfterCloseRef.current?.()
    hostAfterCloseRef.current?.()
  }, [mounted])

  const handleHidden = useCallback(() => {
    if (hiddenHandledRef.current) {
      return
    }
    hiddenHandledRef.current = true
    afterClosePendingRef.current = true
    setMounted(false)
  }, [])
  const resolvedMounted = resolveBottomDrawerMounted(visible, mounted)

  // Why: opening drawers should mount before commit; waiting for a passive
  // Effect adds a null render before every drawer can animate in.
  if (resolvedMounted !== mounted) {
    setMounted(resolvedMounted)
  }

  // Why: hidden drawers are rendered by parent screens even while closed; keep
  // their Reanimated/Gesture setup out of hot paths like commit-message typing.
  if (!resolvedMounted) {
    return null
  }

  return (
    <MountedBottomDrawer
      visible={visible}
      onClose={onClose}
      onHidden={handleHidden}
      dragContentToDismiss={dragContentToDismiss}
      contentScrollable={contentScrollable}
      fillAvailable={fillAvailable}
      interactive={interactive}
      zIndex={zIndex}
    >
      {children}
    </MountedBottomDrawer>
  )
}
