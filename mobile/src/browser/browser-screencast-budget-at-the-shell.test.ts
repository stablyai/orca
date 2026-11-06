import { describe, expect, it } from 'vitest'
import { BRIDGE_MAX_MESSAGE_BYTES, utf8ByteLength } from '../mobile-web-shell/bridge/bridge-caps'
import { clientFrame } from '../mobile-web-shell/bridge-host-test-fakes'
import { harness, ID } from '../mobile-web-shell/bridge-host-test-harness'
import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../transport/browser-screencast-protocol'
import {
  binaryEventEnvelopeBytes,
  mobileBrowserFrameAreaBudget,
  WORST_CASE_JPEG_BYTES_PER_PIXEL
} from './browser-screencast-request.web'

// Use all nine Chromium metadata fields and real epoch/microsecond timestamp; toy integer understates envelope width.
const CDP_METADATA = {
  offsetTop: 0,
  pageScaleFactor: 1,
  deviceWidth: 390,
  deviceHeight: 712,
  imageWidth: 780,
  imageHeight: 1424,
  scrollOffsetX: 0,
  scrollOffsetY: 2048.5,
  timestamp: 1_758_326_400.123456
}

// Deterministic unstructured noise exercises JPEG worst case reproducibly.
function noise(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength)
  let state = 0x9e37_79b9
  for (let index = 0; index < byteLength; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    bytes[index] = (state >>> 24) & 0xff
  }
  return bytes
}

function screencastFrame(image: Uint8Array): BrowserScreencastFrame {
  return {
    opcode: BrowserScreencastOpcode.Frame,
    seq: FRAME_SEQ,
    format: 'jpeg',
    metadata: CDP_METADATA,
    image
  }
}

// Exercise a noninitial screencast frame counter.
const FRAME_SEQ = 4_096

/** The one frame the shell posted for this image, and what it cost besides the image. */
function postedFrame(image: Uint8Array): { bytes: number; envelope: number; posts: number } {
  const bridge = harness({ ready: true })
  bridge.host.receive(
    clientFrame({
      type: 'subscribe',
      id: ID,
      method: 'browser.screencast',
      params: { worktree: 'id:w', page: 'p' },
      wantsBinary: true
    })
  )
  const before = bridge.posted.length
  // Fail if no binary lane opened; optional chaining would otherwise look like a correctly dropped frame.
  const emitBinary = bridge.client.streams[0]?.emitBinary
  if (emitBinary === null || emitBinary === undefined) {
    throw new Error('the subscribe opened no binary stream')
  }
  emitBinary(screencastFrame(image))
  const json = bridge.posted.at(-1) ?? ''
  const posts = bridge.posted.length - before
  const event = posts === 0 ? null : bridge.last()
  const b64 = event !== null && 'binary' in event ? event.binary.b64 : ''
  return { bytes: utf8ByteLength(json), envelope: utf8ByteLength(json) - b64.length, posts }
}

// These synthetic bytes prove base64 arithmetic/drop rules, not JPEG bytes-per-pixel assumption.
describe('a frame at exactly the budgeted area', () => {
  /** The image the budget says the mobile view's worst case produces, to the byte. */
  const BUDGETED_IMAGE_BYTES = Math.floor(
    mobileBrowserFrameAreaBudget() * WORST_CASE_JPEG_BYTES_PER_PIXEL
  )

  it('encodes under the frame cap and the shell posts it', () => {
    const { bytes, posts } = postedFrame(noise(BUDGETED_IMAGE_BYTES))

    expect(posts).toBe(1)
    expect(bytes).toBeLessThanOrEqual(BRIDGE_MAX_MESSAGE_BYTES)
  })

  it('is a ceiling: an image past it is dropped by the shell, not sent over the cap', () => {
    // Unexpected worst-case overflow must be dropped at shell boundary (C6 ruling 1).
    const { posts } = postedFrame(noise(BUDGETED_IMAGE_BYTES + binaryEventEnvelopeBytes()))

    expect(posts).toBe(0)
  })
})
