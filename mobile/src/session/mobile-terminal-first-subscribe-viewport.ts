import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import type { MutableRef, TerminalViewportDims } from './mobile-terminal-viewport-resubscribe'

export type TerminalViewportFromCellBoxArgs = {
  handle: string
  ref: Pick<TerminalWebViewHandle, 'fitDimensions' | 'holdSubscribedGrid'> | undefined
  viewportRef: MutableRef<TerminalViewportDims | null>
  viewportMeasuredRef: MutableRef<boolean>
  terminalFrameWidthRef: MutableRef<number>
  terminalFrameHeightRef: MutableRef<number>
  onMeasured: (
    handle: string,
    dims: TerminalViewportDims | null | undefined,
    frameHeight: number
  ) => void
}

/**
 * Gives an unmeasured route its viewport from the cell box the ready document reported, so the
 * subscribe about to go out carries phone dims and the host serializes the snapshot at the phone's
 * size. Without a box it leaves the route unmeasured.
 */
export function sizeTerminalViewportFromCellBox(args: TerminalViewportFromCellBoxArgs): void {
  if (args.viewportMeasuredRef.current || !args.ref) {
    return
  }
  const frameHeight = args.terminalFrameHeightRef.current
  const dims = args.ref.fitDimensions({
    width: args.terminalFrameWidthRef.current,
    height: frameHeight
  })
  args.onMeasured(args.handle, dims, frameHeight)
  if (dims) {
    args.ref.holdSubscribedGrid(dims)
    args.viewportRef.current = dims
    args.viewportMeasuredRef.current = true
  }
}
