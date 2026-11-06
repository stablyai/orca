// Use page’s JS buffer shim, not Node builtin: C++ base64 encodes frame-sized buffers ~20x faster and understates phone cost.
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

describe('the browser frame data URI', () => {
  it('is byte-identical on both platforms for the frame the bridge decoded', () => {
    const image = makeImageBytes(FRAME_BYTES)
    const b64 = Buffer.from(image).toString('base64')

    expect(createBrowserFrameDataUriOnWeb(makeFrame(image, b64))).toBe(
      createBrowserFrameDataUri(makeFrame(image))
    )
  })

  // Give halves conflicting values to prove web uses supplied b64 without re-encoding image; bridge never produces mismatch.
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
})
