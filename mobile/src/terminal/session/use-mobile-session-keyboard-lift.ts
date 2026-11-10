import { useKeyboardOcclusion } from '../../platform/keyboard-occlusion'
import { hostOs } from '../../platform/host-os'
import { computeActiveTerminalKeyboardLift } from '../terminal-keyboard-avoidance-lift'
import type { MobileSessionController } from '../../session/use-mobile-session-controller'

// Read where the layout moves, so a keyboard change re-renders those views and not the whole session.
// Expo edge-to-edge keeps window size on IME open; lift input from keyboard height without resizing the desktop PTY.
export function useMobileSessionKeyboardLift(dockBottomInset: number): number {
  const keyboardHeight = useKeyboardOcclusion()
  if (keyboardHeight <= 0) {
    return 0
  }
  // Subtract only the space actually reserved below the input dock.
  return hostOs() === 'ios' ? Math.max(0, keyboardHeight - dockBottomInset) : keyboardHeight
}

// The content row also lifts the active terminal by what the keyboard hides and the toast above the dock.
export function useMobileSessionContentKeyboardLift(controller: MobileSessionController) {
  const { activeHandle, terminalKeyboardMetrics, toastOpacityRef, toastRise } = controller
  const keyboardLift = useMobileSessionKeyboardLift(controller.dockBottomInset)
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
  return { keyboardLift, activeTerminalKeyboardLift, toastAnimatedStyle }
}
