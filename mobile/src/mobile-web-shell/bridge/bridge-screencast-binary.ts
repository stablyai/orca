import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../../transport/browser-screencast-protocol'
import type { BridgeHostMessage } from './bridge-envelope'

// Decode only base64 image bytes; format/frameSeq/metadata already cross in JSON, so no socket wire header needs parsing.
export type BridgeBinaryEvent = Extract<
  Extract<BridgeHostMessage, { type: 'event' }>,
  { binary: unknown }
>['binary']

export function decodeBridgeScreencastFrame(
  event: BridgeBinaryEvent
): BrowserScreencastFrame | null {
  const image = decodeBase64(event.b64)
  if (image === null) {
    return null
  }
  return {
    opcode: BrowserScreencastOpcode.Frame,
    // Use screencast frameSeq; bridge seq belongs to acknowledgement/backpressure and would renumber reported images.
    seq: event.frameSeq,
    format: event.format,
    metadata: event.metadata,
    image,
    // Retain received base64 for data URIs instead of re-encoding the decoded image.
    b64: event.b64
  }
}

// Use atob like existing mobile E2EE paths; Metro supplies no Buffer.
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
