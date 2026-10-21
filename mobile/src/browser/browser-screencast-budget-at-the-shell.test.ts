/**
 * The page's frame budget, checked against the frame the shell really posts.
 *
 * `browser-screencast-request.web.ts` sizes the mobile view from `binaryEventEnvelopeBytes()`, a
 * bound it derives from a skeleton it builds itself. Its own suite checks that bound against
 * another skeleton of the same shape, which is two copies of one assumption agreeing. This is the
 * case that makes it evidence: a real `event.binary` encoded by C6.1's encoder and serialized by
 * the real `BridgeHostSubscriptions`, measured, and the bound held above it.
 *
 * C6 ruling 2's pin. The frames are generated noise at the budgeted scale rather than a fixture
 * committed to the tree: the budget's worst case is the image JPEG compresses least, and a
 * downloaded photograph would sit a tenth of the way to it and prove nothing.
 *
 * Measured at this base, so a later reader can tell drift from a rewrite: the real envelope costs
 * 303 bytes against a bound of 516, and a frame at the budgeted area is an image the shell posts
 * just under the 655,360-byte cap. The area itself moved when the worst case was swept properly,
 * so the figures are derived here rather than written down.
 */
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

/** What the bound spends per number: seventeen significant digits and the widest fixed notation
 *  JSON writes, `-0.0000012345678901234567`, and `Number.MAX_SAFE_INTEGER` for the two counters. */
const WIDEST_JSON_DOUBLE_CHARS = 25
const LARGEST_INTEGER_CHARS = JSON.stringify(Number.MAX_SAFE_INTEGER).length

/**
 * A frame's metadata as Chromium sends it: all nine fields, and a `timestamp` that is a real
 * `Page.screencastFrame` value rather than a toy integer.
 *
 * The timestamp is the whole difference between a plausible envelope and the real one — epoch
 * seconds with microseconds is sixteen characters where `1` is one — so a pin written with a small
 * number would measure an envelope no frame ever has.
 */
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

/** Noise, which is what the worst case is: any structure at all is something JPEG would compress.
 *  Deterministic rather than seeded off the clock, so the measured bytes are the same every run. */
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

/** The screencast counter the frame below carries, and the event seq the shell gives its first
 *  event, both needed to reconstruct what the bound assumed about them. */
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
  // Loudly, because the optional chain below would otherwise turn a subscribe that opened no
  // binary lane into zero posts, which is what a dropped frame looks like.
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
    // Base64 is ASCII and JSON escapes none of it, so the image contributes its characters and
    // nothing else. This is the premise the shell prices an unencoded frame on.
    expect(postedFrame(noise(1_024)).envelope).toBe(postedFrame(noise(256 * 1024)).envelope)
  })

  /**
   * The bound, reconstructed from the real frame rather than merely held above it.
   *
   * Above-it alone is satisfied by 213 bytes of slack, which is room for the shell to grow the
   * envelope by a field the page never hears about. The slack is not arbitrary: every byte of it
   * is a value this frame prints narrower than a double can. Adding exactly those back is the
   * whole difference, so an envelope field the bound does not know about fails here at one byte.
   */
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
    // If a tenth field is added, `METADATA_KEYS` grows, the bound grows with it, and the frame
    // above keeps fitting. The guard is that this case sends all of them.
    expect(Object.keys(CDP_METADATA).sort()).toEqual([...METADATA_KEYS].sort())
  })
})

/**
 * The arithmetic between the budget and the cap, and nothing about what a JPEG really costs.
 *
 * Every case here feeds `noise(area * WORST_CASE_JPEG_BYTES_PER_PIXEL)` — a byte count the constant
 * itself produced — so they cannot falsify the constant, only the expansion and the drop rule
 * around it. Said plainly because the earlier version of this block read as if it validated the
 * worst case: it did not, and the constant it agreed with was wrong by enough to post a phone's
 * frame over the cap. `config/scripts/mobile-web-app-frame-budget-sweep.test.ts` is what encodes
 * real Chromium JPEGs across the viewport range and holds the constant to them.
 */
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
    // A budget with room to spare is pixels the pane could have had. Within one base64 group plus
    // the slack the envelope bound deliberately carries.
    const { bytes } = postedFrame(noise(BUDGETED_IMAGE_BYTES))

    expect(BRIDGE_MAX_MESSAGE_BYTES - bytes).toBeLessThan(binaryEventEnvelopeBytes())
  })

  it('is a ceiling: an image past it is dropped by the shell, not sent over the cap', () => {
    // C6 ruling 1 from the budget's side. The area is a worst case, so a real frame this size is
    // the one the page could not predict, and the shell is what keeps it off the wire.
    const { posts } = postedFrame(noise(BUDGETED_IMAGE_BYTES + binaryEventEnvelopeBytes()))

    expect(posts).toBe(0)
  })
})
