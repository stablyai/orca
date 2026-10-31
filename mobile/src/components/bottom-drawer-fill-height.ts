// Stable fill height keeps docked input from riding results; shrink height and lift marginBottom by keyboard inset to put bottom edge above keys.

export function resolveBottomDrawerFillHeight(input: {
  screenHeight: number
  topInset: number
  keyboardInset: number
  topGap?: number
}): number {
  const topGap = input.topGap ?? 16
  const keyboardInset = Math.max(0, input.keyboardInset)
  // Cap below status-bar gap and above keyboard; hard minHeight would grow upward under status bar while full inset still lifts sheet.
  return Math.max(0, input.screenHeight - input.topInset - topGap - keyboardInset)
}
