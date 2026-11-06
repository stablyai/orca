import { computeActiveTerminalKeyboardLift } from '../terminal/terminal-keyboard-avoidance-lift'
import type { TerminalKeyboardAvoidanceMetrics } from '../terminal/terminal-webview-contract'
import { terminalPaneKeyboardLayout } from './mobile-terminal-pane-layout'
import type { TerminalFrame } from '../terminal/terminal-webview-messages'

export function terminalPaneKeyboardLift(args: {
  handle: string
  activeHandle: string | null
  splitHandles: readonly string[] | null
  paneFrame: TerminalFrame
  paneDirection: 'row' | 'column'
  keyboardLift: number
  activeTerminalKeyboardLift: number
  metrics: TerminalKeyboardAvoidanceMetrics | undefined
  getTerminalFrameHeight: () => number
}): number {
  const { handle, splitHandles } = args
  if (handle !== args.activeHandle && !splitHandles?.includes(handle)) {
    return 0
  }
  if (!splitHandles) {
    return args.activeTerminalKeyboardLift
  }
  return computeActiveTerminalKeyboardLift({
    keyboardLift: terminalPaneKeyboardLayout(
      args.paneFrame,
      args.paneDirection,
      splitHandles.indexOf(handle),
      args.keyboardLift
    ).occlusion,
    metrics: args.metrics,
    terminalFrameHeight: args.getTerminalFrameHeight()
  })
}
