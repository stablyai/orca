import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import type { MutableRef, TerminalViewportDims } from './mobile-terminal-viewport-resubscribe'

export type TerminalViewportSeedArgs = {
  handle: string
  ref: Pick<TerminalWebViewHandle, 'fitDimensions'> | undefined
  viewportRef: MutableRef<TerminalViewportDims | null>
  viewportMeasuredRef: MutableRef<boolean>
  terminalFrameHeightRef: MutableRef<number>
  onMeasured: (
    handle: string,
    dims: TerminalViewportDims | null | undefined,
    frameHeight: number
  ) => void
}

/**
 * Gives an unmeasured route its viewport from the document's reported cell box, so the subscribe
 * about to go out carries phone dims and the host serializes the snapshot at the phone's size.
 * Without a reported box it leaves the route unmeasured and the post-init fit pass measures.
 */
export function seedTerminalViewportFromCellMetrics(args: TerminalViewportSeedArgs): void {
  if (args.viewportMeasuredRef.current || !args.ref) {
    return
  }
  const frameHeight = args.terminalFrameHeightRef.current
  const dims = args.ref.fitDimensions(frameHeight || undefined)
  args.onMeasured(args.handle, dims, frameHeight)
  if (dims) {
    args.viewportRef.current = dims
    args.viewportMeasuredRef.current = true
  }
}
