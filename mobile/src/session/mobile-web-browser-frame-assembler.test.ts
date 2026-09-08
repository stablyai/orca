import { Buffer } from 'buffer/'
import { describe, expect, it } from 'vitest'
import type { MobileWebBrowserFrameChunk } from '../../../src/shared/mobile-web/browser-operation-contract'
import { MobileWebBrowserFrameAssembler } from './mobile-web-browser-frame-assembler'

describe('mobile web browser frame assembler', () => {
  it('reassembles independently padded chunks without changing bytes', () => {
    const assembler = new MobileWebBrowserFrameAssembler()
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 250])

    expect(assembler.push(chunk(0, 2, bytes.subarray(0, 4), bytes.byteLength))).toBeNull()
    const frame = assembler.push(chunk(1, 2, bytes.subarray(4), bytes.byteLength))

    expect(frame).toMatchObject({
      seq: 17,
      format: 'jpeg',
      metadata: { deviceWidth: 390, deviceHeight: 640 }
    })
    expect(frame?.image).toEqual(bytes)
  })

  it('fails closed on skipped or inconsistent chunks and can recover with a new frame', () => {
    const assembler = new MobileWebBrowserFrameAssembler()

    expect(() => assembler.push(chunk(1, 2, new Uint8Array([2]), 2))).toThrow(
      'Browser frame chunks are inconsistent'
    )
    expect(
      assembler.push({
        ...chunk(0, 1, new Uint8Array([7]), 1),
        frameSequence: 18
      })
    ).toMatchObject({ seq: 18, image: new Uint8Array([7]) })
  })
})

function chunk(
  chunkIndex: number,
  chunkCount: number,
  bytes: Uint8Array,
  imageBytes: number
): MobileWebBrowserFrameChunk {
  return {
    type: 'frameChunk',
    frameSequence: 17,
    format: 'jpeg',
    metadata: { deviceWidth: 390, deviceHeight: 640 },
    imageBytes,
    chunkIndex,
    chunkCount,
    data: Buffer.from(bytes).toString('base64')
  }
}
