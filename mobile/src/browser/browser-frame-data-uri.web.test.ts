// The encoder the page really runs. A bare `buffer` specifier reaches Node's builtin under vitest,
// which encodes in C++; the page bundle resolves it to this shim, which encodes in JS and is
// roughly twenty times slower on a frame-sized buffer. Measuring against the builtin would put the
// cost of the re-encode an order of magnitude below what a phone pays for it.
import { Buffer } from 'buffer/index.js'
import { describe, expect, it } from 'vitest'
import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../transport/browser-screencast-protocol'
import { createBrowserFrameDataUri } from './browser-frame-data-uri'
import { createBrowserFrameDataUri as createBrowserFrameDataUriOnWeb } from './browser-frame-data-uri.web'

/** The phone's own mobile-mode frame, near the p50 a real screencast produced at quality 72. */
const FRAME_BYTES = 45_815

/** High entropy, as a JPEG is: a run of zeros would encode at a speed no frame ever sees. */
function makeImageBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength)
  let state = 0x9e37_79b9
  for (let index = 0; index < byteLength; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    bytes[index] = state >>> 24
  }
  return bytes
}

function makeFrame(image: Uint8Array, b64?: string): BrowserScreencastFrame {
  return {
    opcode: BrowserScreencastOpcode.Frame,
    seq: 7,
    format: 'jpeg',
    metadata: { deviceWidth: 390, deviceHeight: 712 },
    image,
    ...(b64 === undefined ? {} : { b64 })
  }
}

function millisecondsPerFrame(run: () => string, frames: number): number {
  const started = performance.now()
  for (let index = 0; index < frames; index += 1) {
    run()
  }
  return (performance.now() - started) / frames
}

describe('the browser frame data URI', () => {
  it('is byte-identical on both platforms for the frame the bridge decoded', () => {
    const image = makeImageBytes(FRAME_BYTES)
    const b64 = Buffer.from(image).toString('base64')

    expect(createBrowserFrameDataUriOnWeb(makeFrame(image, b64))).toBe(
      createBrowserFrameDataUri(makeFrame(image))
    )
  })

  // The oracle for "it did not re-encode": a frame whose two halves disagree, which the bridge
  // never produces. A web sibling that encoded `image` anyway would answer the native string.
  it('uses the base64 the bridge carried rather than the bytes beside it', () => {
    const uri = createBrowserFrameDataUriOnWeb(makeFrame(makeImageBytes(64), 'Y2FycmllZA=='))

    expect(uri).toBe('data:image/jpeg;base64,Y2FycmllZA==')
  })

  it('still paints a frame that carried no base64, which is every native frame', () => {
    const image = makeImageBytes(64)

    expect(createBrowserFrameDataUriOnWeb(makeFrame(image))).toBe(
      createBrowserFrameDataUri(makeFrame(image))
    )
  })

  it('costs less per frame than the re-encode it replaces', () => {
    const image = makeImageBytes(FRAME_BYTES)
    const b64 = Buffer.from(image).toString('base64')
    const frames = 100
    const reEncode = (): string => `data:image/jpeg;base64,${Buffer.from(image).toString('base64')}`
    const carried = (): string => createBrowserFrameDataUriOnWeb(makeFrame(image, b64))

    // Both warmed in the same harness before either is timed, so neither pays for a cold JIT.
    millisecondsPerFrame(reEncode, 20)
    millisecondsPerFrame(carried, 20)
    const reEncodeMs = millisecondsPerFrame(reEncode, frames)
    const carriedMs = millisecondsPerFrame(carried, frames)

    // Loose on purpose: the measured gap is three orders of magnitude, and a bound near it would
    // make a shared CI runner's noise a red build rather than a finding.
    expect(carriedMs).toBeLessThan(reEncodeMs / 10)
  })
})
