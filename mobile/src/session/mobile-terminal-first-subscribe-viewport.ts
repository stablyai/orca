import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import type { TerminalViewportDims } from './mobile-terminal-viewport-resubscribe'

type MutableRef<T> = { current: T }

export type TerminalViewportMeasureTarget = Pick<TerminalWebViewHandle, 'measureFitDimensions'>

export type TerminalViewportOnceArgs = {
  handle: string
  ref: TerminalViewportMeasureTarget | undefined
  viewportRef: MutableRef<TerminalViewportDims | null>
  viewportMeasuredRef: MutableRef<boolean>
  terminalFrameHeightRef: MutableRef<number>
  onMeasured: (
    handle: string,
    dims: TerminalViewportDims | null | undefined,
    frameHeight: number
  ) => void
}

/** Measures the phone viewport once per route; the dims then ride every subscribe so the host fits the PTY itself. */
export async function measureTerminalViewportOnce(args: TerminalViewportOnceArgs): Promise<void> {
  if (args.viewportMeasuredRef.current) {
    return
  }
  const dims = await args.ref?.measureFitDimensions(
    args.terminalFrameHeightRef.current || undefined
  )
  args.onMeasured(args.handle, dims, args.terminalFrameHeightRef.current)
  if (dims) {
    args.viewportRef.current = dims
    args.viewportMeasuredRef.current = true
  }
}
