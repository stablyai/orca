import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import type { TerminalFrame } from '../terminal/terminal-webview-messages'
import type { MutableRef, TerminalViewportDims } from './mobile-terminal-viewport-resubscribe'

export type TerminalViewportFromCellBoxArgs = {
  handle: string
  ref: Pick<TerminalWebViewHandle, 'fitDimensions' | 'holdSubscribedGrid'> | undefined
  viewportRef: MutableRef<TerminalViewportDims | null>
  viewportMeasuredRef: MutableRef<boolean>
  terminalFrameRef: MutableRef<TerminalFrame | null>
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
  const frame = args.terminalFrameRef.current
  const dims = frame ? args.ref.fitDimensions(frame) : null
  args.onMeasured(args.handle, dims, frame?.height ?? 0)
  if (dims) {
    args.ref.holdSubscribedGrid(dims)
    args.viewportRef.current = dims
    args.viewportMeasuredRef.current = true
  }
}
