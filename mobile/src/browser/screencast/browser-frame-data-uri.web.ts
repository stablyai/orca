import type { BrowserScreencastFrame } from './browser-screencast-protocol'
import { encodeBase64Bytes } from '../../transport/encryption/base64-byte-codec'

// Reuse bridge b64: re-encoding costs 75–90% of page frame handling and grows with frame size.
// Optional b64 keeps non-bridge callers working via native encoding; streaming always supplies it.
export function createBrowserFrameDataUri(frame: BrowserScreencastFrame): string {
  const base64 = frame.b64 ?? encodeBase64Bytes(frame.image)
  return `data:image/${frame.format};base64,${base64}`
}
