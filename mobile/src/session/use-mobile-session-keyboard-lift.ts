import { useSyncExternalStore } from 'react'
import { currentSoftKeyboardHeight, subscribeSoftKeyboard } from '../platform/keyboard-occlusion'
import { hostOs } from '../platform/host-os'
import { computeActiveTerminalKeyboardLift } from '../terminal/terminal-keyboard-avoidance-lift'
import type { MobileSessionController } from './use-mobile-session-controller'

function subscribeKeyboardHeight(onChange: () => void): () => void {
  return subscribeSoftKeyboard(onChange, onChange)
}

// Read where the layout moves, so a keyboard change re-renders those views and not the whole session.
export function useMobileSessionKeyboardLift(controller: MobileSessionController) {
  const { activeHandle, dockBottomInset, terminalKeyboardMetrics, toastOpacityRef, toastRise } =
    controller
  // Expo edge-to-edge keeps window size on IME open; lift input from keyboard height without resizing the desktop PTY.
  const keyboardHeight = useSyncExternalStore(subscribeKeyboardHeight, currentSoftKeyboardHeight)
  // Subtract only the space actually reserved below the input dock.
  const keyboardLift =
    keyboardHeight > 0
      ? hostOs() === 'ios'
        ? Math.max(0, keyboardHeight - dockBottomInset)
        : keyboardHeight
      : 0
  const activeTerminalKeyboardLift = computeActiveTerminalKeyboardLift({
    keyboardLift,
    metrics: activeHandle ? terminalKeyboardMetrics.get(activeHandle) : undefined,
    terminalFrameHeight:
      (activeHandle
        ? controller.getTerminalPaneViewport?.(activeHandle).terminalFrameRef.current?.height
        : null) ??
      controller.terminalFrameRef.current?.height ??
      0
  })
  const toastAnimatedStyle = {
    opacity: toastOpacityRef.current,
    transform: [{ translateY: -keyboardLift }, { translateY: toastRise }]
  }
  return { keyboardHeight, keyboardLift, activeTerminalKeyboardLift, toastAnimatedStyle }
}
