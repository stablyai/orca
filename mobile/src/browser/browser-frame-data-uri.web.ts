import { Buffer } from 'buffer'
import type { BrowserScreencastFrame } from '../transport/browser-screencast-protocol'

/**
 * Web sibling: the bridge handed the page base64 and the data URI wants base64, so re-encoding the
 * bytes in between is work the frame already paid for once.
 *
 * It is the page's largest per-frame cost by some way — the re-encode was measured at 75–90% of
 * everything the page spends between the message arriving and the frame being painted — and it
 * grows with the frame, which is exactly the direction a slow device gets worse in.
 *
 * The fallback is the native encoding rather than nothing: `b64` is optional on the frame because
 * only the bridge decoder carries it, and a frame that reached this page any other way must still
 * paint. The streaming path never reaches it.
 */
export function createBrowserFrameDataUri(frame: BrowserScreencastFrame): string {
  const base64 = frame.b64 ?? Buffer.from(frame.image).toString('base64')
  return `data:image/${frame.format};base64,${base64}`
}
