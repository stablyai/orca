import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import type { MutableRef, TerminalViewportDims } from './mobile-terminal-viewport-resubscribe'

/** Any size opens xterm; cell metrics, not the grid, are what the measure needs. */
const EMPTY_TERMINAL_COLS = 80
const EMPTY_TERMINAL_ROWS = 24

export type TerminalViewportMeasureTarget = Pick<
  TerminalWebViewHandle,
  'init' | 'awaitReady' | 'measureFitDimensions'
>

export type TerminalViewportOnceArgs = {
  handle: string
  ref: TerminalViewportMeasureTarget | undefined
  /** False until the document's first init; it has no xterm, so no cell metrics, before one. */
  documentHasTerminal: boolean
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
  const ref = args.ref
  if (ref && !args.documentHasTerminal) {
    // Why: without this the first subscribe goes dimensionless, paints at the desktop's size, then resubscribes.
    ref.init(EMPTY_TERMINAL_COLS, EMPTY_TERMINAL_ROWS, '')
    await ref.awaitReady()
  }
  const dims = await ref?.measureFitDimensions(args.terminalFrameHeightRef.current || undefined)
  args.onMeasured(args.handle, dims, args.terminalFrameHeightRef.current)
  if (dims) {
    args.viewportRef.current = dims
    args.viewportMeasuredRef.current = true
  }
}

export type FirstSubscribeViewportGateArgs = {
  handle: string
  covered: boolean
  viewportMeasured: boolean
  /** Handles whose current document has already been subscribed; cleared when that document goes away. */
  subscribedDocuments: Set<string>
  subscribingHandles: Set<string>
  subscribeSeq: ReadonlyMap<string, number>
  measure: (handle: string) => Promise<void>
  subscribe: (handle: string) => void
}

/**
 * Holds a document's first subscribe until the route's viewport is measured, so the host
 * serializes the snapshot at the phone's size. Returns true when it took over the subscribe.
 */
export function deferFirstSubscribeUntilViewportMeasured(
  args: FirstSubscribeViewportGateArgs
): boolean {
  const { handle } = args
  // A covered lease has no document to measure and asks for no viewport.
  if (args.covered) {
    return false
  }
  const firstForDocument = !args.subscribedDocuments.has(handle)
  args.subscribedDocuments.add(handle)
  if (!firstForDocument || args.viewportMeasured) {
    return false
  }
  args.subscribingHandles.add(handle)
  const seq = args.subscribeSeq.get(handle)
  const resume = (): void => {
    // Why: unsubscribeTerminal bumps the seq and clears the in-flight mark; a torn-down handle stays down.
    if (args.subscribeSeq.get(handle) !== seq || !args.subscribingHandles.has(handle)) {
      return
    }
    args.subscribingHandles.delete(handle)
    args.subscribe(handle)
  }
  void args.measure(handle).then(resume, resume)
  return true
}
