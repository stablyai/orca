import { Buffer } from 'buffer'
import type { BrowserScreencastFrame } from '../transport/browser-screencast-protocol'

/** Native: the socket handed the page bytes, so the data URI's base64 is encoded here. */
export function createBrowserFrameDataUri(frame: BrowserScreencastFrame): string {
  return `data:image/${frame.format};base64,${Buffer.from(frame.image).toString('base64')}`
}
