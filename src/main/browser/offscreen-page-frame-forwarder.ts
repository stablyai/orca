/** One GPU frame from an offscreen page; `release` returns it to Chromium's small texture pool. */
export type OffscreenPageFrame = {
  release(): void
}

export type OffscreenPageFrameTransport<TFrame extends OffscreenPageFrame> = {
  /** Deliver one frame to the renderer that displays the page. Resolves once the renderer holds it. */
  deliver(frame: TFrame): Promise<void>
}

export type OffscreenPageFrameForwarder<TFrame extends OffscreenPageFrame> = {
  onPaint(frame: TFrame): void
  /** Drop the parked frame and stop forwarding; later paints are released immediately. */
  dispose(): void
}

/**
 * Keeps at most one frame in flight and one parked. A paint that arrives mid-delivery replaces the
 * parked frame instead of queueing, because Chromium's texture pool is tiny and a backlog stalls
 * painting. The parked frame is always delivered afterwards, so a page that stops painting still
 * shows its final state.
 */
export function createOffscreenPageFrameForwarder<TFrame extends OffscreenPageFrame>(
  transport: OffscreenPageFrameTransport<TFrame>,
  onDeliveryError: (error: unknown) => void = () => {}
): OffscreenPageFrameForwarder<TFrame> {
  let inFlight = false
  let parked: TFrame | null = null
  let disposed = false

  const pump = (frame: TFrame): void => {
    inFlight = true
    transport
      .deliver(frame)
      .catch(onDeliveryError)
      .finally(() => {
        inFlight = false
        const next = parked
        parked = null
        if (next && !disposed) {
          pump(next)
        } else {
          next?.release()
        }
      })
  }

  return {
    onPaint(frame) {
      if (disposed) {
        frame.release()
        return
      }
      if (!inFlight) {
        pump(frame)
        return
      }
      parked?.release()
      parked = frame
    },
    dispose() {
      disposed = true
      parked?.release()
      parked = null
    }
  }
}
