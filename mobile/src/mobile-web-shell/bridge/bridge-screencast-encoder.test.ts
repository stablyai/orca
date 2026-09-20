import { describe, expect, it } from 'vitest'
import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../../transport/browser-screencast-protocol'
import { decodeBridgeScreencastFrame } from './bridge-screencast-binary'
import { encodeBase64, encodeBridgeScreencastFrame } from './bridge-screencast-encoder'

function frameOf(image: Uint8Array, overrides: Partial<BrowserScreencastFrame> = {}) {
  return {
    opcode: BrowserScreencastOpcode.Frame,
    seq: 41,
    format: 'jpeg',
    metadata: { imageWidth: 8 },
    image,
    ...overrides
  } satisfies BrowserScreencastFrame
}

describe('the shell encodes a screencast frame the page can decode', () => {
  it('round-trips through the real decoder, image byte for byte', () => {
    const image = Uint8Array.from(
      { length: 5000 },
      (_, index) => (index * 31 + (index >> 7)) & 0xff
    )
    const decoded = decodeBridgeScreencastFrame(encodeBridgeScreencastFrame(frameOf(image)))
    expect(decoded).not.toBeNull()
    expect(decoded?.image).toEqual(image)
  })

  it('carries every metadata field, the format and the screencast seq', () => {
    const metadata = {
      offsetTop: 1,
      pageScaleFactor: 2,
      deviceWidth: 3,
      deviceHeight: 4,
      imageWidth: 5,
      imageHeight: 6,
      scrollOffsetX: 7,
      scrollOffsetY: 8,
      timestamp: 9
    }
    const event = encodeBridgeScreencastFrame(
      frameOf(Uint8Array.of(1, 2, 3), { format: 'png', seq: 77, metadata })
    )
    expect(event).toEqual({ b64: expect.any(String), format: 'png', frameSeq: 77, metadata })
    expect(decodeBridgeScreencastFrame(event)).toEqual({
      opcode: BrowserScreencastOpcode.Frame,
      seq: 77,
      format: 'png',
      metadata,
      image: Uint8Array.of(1, 2, 3)
    })
  })

  it('encodes every byte value, which is where a charCode path goes wrong', () => {
    const image = Uint8Array.from({ length: 256 }, (_, index) => index)
    expect(decodeBridgeScreencastFrame(encodeBridgeScreencastFrame(frameOf(image)))?.image).toEqual(
      image
    )
  })

  /** A grouped encoder is wrong exactly at the tail: one image whose length divides by three
   *  exercises neither padding arm. */
  it('round-trips at every remainder and across the group boundary', () => {
    const lengths = [0, 1, 2, 3, 4, 5, 6, 7, 8191, 8192, 8193, 8194, 16_384, 16_385, 24_575]
    for (const length of lengths) {
      const image = Uint8Array.from({ length }, (_, index) => (index * 7 + 3) & 0xff)
      const decoded = decodeBridgeScreencastFrame(encodeBridgeScreencastFrame(frameOf(image)))
      expect({ length, image: decoded?.image }).toEqual({ length, image })
    }
  })

  it('agrees with the platform encoder on a frame-sized image and at every remainder', () => {
    // The oracle is Node's own base64, which the page's `atob` is the inverse of. Round-tripping
    // through this module's own decoder cannot see an alphabet or a padding both halves share.
    const image = Uint8Array.from({ length: 77_293 }, (_, index) => (index * 13 + 5) & 0xff)
    expect(encodeBase64(image)).toBe(Buffer.from(image).toString('base64'))
    for (const length of [0, 1, 2, 3, 4, 5, 255, 256, 257]) {
      const tail = image.subarray(0, length)
      expect({ length, b64: encodeBase64(tail) }).toEqual({
        length,
        b64: Buffer.from(tail).toString('base64')
      })
    }
  })

  it('encodes an empty image as an empty string rather than throwing', () => {
    const event = encodeBridgeScreencastFrame(frameOf(new Uint8Array(0)))
    expect(event.b64).toBe('')
    expect(decodeBridgeScreencastFrame(event)?.image).toEqual(new Uint8Array(0))
  })
})
