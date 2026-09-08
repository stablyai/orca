import { decodeTerminalStreamFrame, type TerminalStreamFrame } from './terminal-stream-protocol'

type MultiplexStream = {
  method: string
  cancelled?: boolean
  onTerminalBinaryFrame?: (frame: TerminalStreamFrame) => boolean
}

export function routeTerminalMultiplexFrame(
  bytes: Uint8Array,
  streams: Iterable<MultiplexStream>
): boolean {
  // Why: decoding copies the whole payload out of the frame, and only the hosted shell ever
  // subscribes `terminal.multiplex`. Decoding first made a native client pay that copy on every
  // terminal output frame before falling through to the router, which decodes it again.
  let frame: TerminalStreamFrame | null | undefined
  for (const stream of streams) {
    if (
      stream.method !== 'terminal.multiplex' ||
      stream.cancelled ||
      !stream.onTerminalBinaryFrame
    ) {
      continue
    }
    if (frame === undefined) {
      frame = decodeTerminalStreamFrame(bytes)
    }
    if (!frame) {
      return false
    }
    if (stream.onTerminalBinaryFrame(frame) === true) {
      return true
    }
  }
  return false
}
