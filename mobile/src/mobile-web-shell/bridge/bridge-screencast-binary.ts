import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../../transport/browser-screencast-protocol'
import type { BridgeHostMessage } from './bridge-envelope'

/**
 * The binary lane's page-side half: base64 in, the same `BrowserScreencastFrame` a native listener
 * is handed out.
 *
 * There is no wire header to parse here. `decodeBrowserScreencastFrame` reads one because the
 * socket carries a frame as a single buffer; the envelope already carries `format`, `frameSeq` and
 * the metadata as JSON beside the image, so only the image is base64. C6 owns the encoder that
 * produces this shape, and this is the inverse it has to satisfy.
 */
export type BridgeBinaryEvent = Extract<
  Extract<BridgeHostMessage, { type: 'event' }>,
  { binary: unknown }
>['binary']

/** `null` when the image is not base64: an undecodable frame is dropped, never guessed at. */
export function decodeBridgeScreencastFrame(
  event: BridgeBinaryEvent
): BrowserScreencastFrame | null {
  const image = decodeBase64(event.b64)
  if (image === null) {
    return null
  }
  return {
    opcode: BrowserScreencastOpcode.Frame,
    // The screencast's own counter. The event frame's `seq` is the bridge's backpressure ordinal,
    // and handing that one over would renumber every frame the page reports.
    seq: event.frameSeq,
    format: event.format,
    metadata: event.metadata,
    image,
    // Kept rather than dropped: the page's data URI wants base64 and this is the base64 it wants,
    // so the web frame path spends nothing re-encoding what arrived already encoded.
    b64: event.b64
  }
}

/** Metro ships no `Buffer`; `atob` is what the pairing and E2EE paths already decode with. */
function decodeBase64(value: string): Uint8Array | null {
  let binary: string
  try {
    binary = atob(value)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
