import { describe, expect, it } from 'vitest'
import { parseH264SpsPictureSize } from './h264-sps-picture-size'

// SPS NAL units produced by x264, framed like a scrcpy config packet (SPS, then PPS).
const HIGH_1080X2400_SPS = '67640032acd94044012de5f011000003000100000300320f183196'
const BASELINE_600X1280_SPS = '6742c01fd900980a1e5f011000000300100000030320f1832480'
const PPS = '68ebe3cb22c0'

function configPacket(spsHex: string): Buffer {
  return Buffer.from(`00000001${spsHex}00000001${PPS}`, 'hex')
}

describe('parseH264SpsPictureSize', () => {
  it('applies frame cropping for a high-profile SPS', () => {
    expect(parseH264SpsPictureSize(configPacket(HIGH_1080X2400_SPS))).toEqual({
      width: 1080,
      height: 2400
    })
  })

  it('reads a baseline SPS behind a 3-byte start code', () => {
    const packet = Buffer.from(`000001${BASELINE_600X1280_SPS}00000001${PPS}`, 'hex')
    expect(parseH264SpsPictureSize(packet)).toEqual({ width: 600, height: 1280 })
  })

  it('returns null without an SPS or when the SPS is truncated', () => {
    expect(parseH264SpsPictureSize(Buffer.from(`00000001${PPS}`, 'hex'))).toBeNull()
    expect(parseH264SpsPictureSize(Buffer.alloc(0))).toBeNull()
    expect(
      parseH264SpsPictureSize(Buffer.from(`00000001${HIGH_1080X2400_SPS.slice(0, 12)}`, 'hex'))
    ).toBeNull()
  })
})
