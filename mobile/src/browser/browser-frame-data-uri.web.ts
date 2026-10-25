import { Buffer } from 'buffer'
import type { BrowserScreencastFrame } from '../transport/browser-screencast-protocol'

// Reuse bridge b64: re-encoding costs 75–90% of page frame handling and grows with frame size.
// Optional b64 keeps non-bridge callers working via native encoding; streaming always supplies it.
export function createBrowserFrameDataUri(frame: BrowserScreencastFrame): string {
  const base64 = frame.b64 ?? Buffer.from(frame.image).toString('base64')
  return `data:image/${frame.format};base64,${base64}`
}
