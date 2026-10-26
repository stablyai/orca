// Hold page’s frame budget against real event.binary encoder and BridgeHostSubscriptions serialization, not matching skeleton copies.
// Use deterministic noise at budgeted scale: JPEG compresses photos too well to test ceiling. Reconstruct envelope bound so added fields fail without hiding in numeric slack.
import { describe, expect, it } from 'vitest'
import { BRIDGE_MAX_MESSAGE_BYTES, utf8ByteLength } from '../mobile-web-shell/bridge/bridge-caps'
import { clientFrame } from '../mobile-web-shell/bridge-host-test-fakes'
import { harness, ID } from '../mobile-web-shell/bridge-host-test-harness'
import {
  BrowserScreencastOpcode,
  METADATA_KEYS,
  type BrowserScreencastFrame
} from '../transport/browser-screencast-protocol'
import {
  binaryEventEnvelopeBytes,
  mobileBrowserFrameAreaBudget,
  WORST_CASE_JPEG_BYTES_PER_PIXEL
} from './browser-screencast-request.web'

// Bound numbers with widest fixed double notation (-0.0000012345678901234567) and MAX_SAFE_INTEGER counters.
const WIDEST_JSON_DOUBLE_CHARS = 25
const LARGEST_INTEGER_CHARS = JSON.stringify(Number.MAX_SAFE_INTEGER).length

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

// Keep actual screencast counter and first event seq to reconstruct bound assumptions.
const FRAME_SEQ = 4_096
const FIRST_EVENT_SEQ = 1

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

describe('the envelope bound against a real posted frame', () => {
  it('holds above what the shell spends on everything but the image', () => {
    const { envelope } = postedFrame(noise(64 * 1024))

    expect(binaryEventEnvelopeBytes()).toBeGreaterThanOrEqual(envelope)
  })

  it('is the same cost whatever the image is, which is what makes it an envelope', () => {
    // Base64 contributes exactly its ASCII character count; JSON escapes none.
    expect(postedFrame(noise(1_024)).envelope).toBe(postedFrame(noise(256 * 1024)).envelope)
  })

  // Reconstruct bound by adding only numeric widening to real envelope; slack-only inequality would hide added fields.
  it('is exactly what this frame costs once every number is widened to a double', () => {
    const widen = (value: number): number => WIDEST_JSON_DOUBLE_CHARS - JSON.stringify(value).length
    const widened =
      postedFrame(noise(1_024)).envelope +
      (LARGEST_INTEGER_CHARS - JSON.stringify(FIRST_EVENT_SEQ).length) +
      (LARGEST_INTEGER_CHARS - JSON.stringify(FRAME_SEQ).length) +
      METADATA_KEYS.reduce((total, key) => total + widen(CDP_METADATA[key]), 0)

    expect(binaryEventEnvelopeBytes()).toBe(widened)
  })

  it('covers every metadata field the protocol declares, not the ones this case sends', () => {
    // Send every METADATA_KEYS entry or a new field could widen bound without appearing in fixture.
    expect(Object.keys(CDP_METADATA).sort()).toEqual([...METADATA_KEYS].sort())
  })
})

// These synthetic bytes prove base64 arithmetic/drop rules, not JPEG bytes-per-pixel assumption.
// config/scripts/mobile-web-app/mobile-web-app-frame-budget-sweep.test.ts validates constant against real Chromium JPEGs across viewports.
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

  it('is tight: the budget spends nearly the whole cap', () => {
    // Demand budget near cap: slack is only one base64 group plus deliberate envelope widening.
    const { bytes } = postedFrame(noise(BUDGETED_IMAGE_BYTES))

    expect(BRIDGE_MAX_MESSAGE_BYTES - bytes).toBeLessThan(binaryEventEnvelopeBytes())
  })

  it('is a ceiling: an image past it is dropped by the shell, not sent over the cap', () => {
    // Unexpected worst-case overflow must be dropped at shell boundary (C6 ruling 1).
    const { posts } = postedFrame(noise(BUDGETED_IMAGE_BYTES + binaryEventEnvelopeBytes()))

    expect(posts).toBe(0)
  })
})
