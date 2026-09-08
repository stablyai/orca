import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_RASTER_IMAGE_MAX_BYTES,
  isMobileWebRasterImagePath,
  validateMobileWebRasterImage
} from './mobile-web-raster-image'

describe('mobile web raster image', () => {
  it('accepts supported extension and signature pairs', () => {
    for (const [relativePath, bytes, mimeType] of [
      ['image.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
      ['image.jpg', [0xff, 0xd8, 0xff], 'image/jpeg'],
      ['image.gif', ascii('GIF89a'), 'image/gif'],
      ['image.webp', [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')], 'image/webp'],
      ['image.bmp', ascii('BM'), 'image/bmp'],
      ['image.ico', [0, 0, 1, 0, 1, 0], 'image/x-icon']
    ] as const) {
      expect(
        validateMobileWebRasterImage({
          relativePath,
          bytes: Uint8Array.from(bytes),
          eof: true,
          limitReached: false
        })
      ).toMatchObject({ valid: true, imageType: { mimeType } })
    }
  })

  it('rejects SVG, extension/signature mismatches, incomplete files, and oversized files', () => {
    expect(isMobileWebRasterImagePath('art.svg')).toBe(false)
    expect(validation('art.svg', ascii('<svg>'))).toEqual({
      valid: false,
      reason: 'unsupported'
    })
    expect(validation('art.png', ascii('<svg>'))).toEqual({
      valid: false,
      reason: 'signature_mismatch'
    })
    expect(validation('art.png', [0x89, 0x50], false)).toEqual({
      valid: false,
      reason: 'incomplete'
    })
    expect(validation('art.png', new Uint8Array(MOBILE_WEB_RASTER_IMAGE_MAX_BYTES + 1))).toEqual({
      valid: false,
      reason: 'too_large'
    })
  })
})

function validation(relativePath: string, values: number[] | Uint8Array, eof = true) {
  return validateMobileWebRasterImage({
    relativePath,
    bytes: Uint8Array.from(values),
    eof,
    limitReached: false
  })
}

function ascii(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0))
}
