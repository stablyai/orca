import { describe, expect, it } from 'vitest'
import { applyCodexSpriteTimingDefaults } from '../../shared/codex-pet-sprite-defaults'
import {
  CODEX_PET_ANIMATIONS,
  CODEX_PET_FRAME,
  CODEX_PET_SPRITESHEET_PATH,
  applyCodexPetDefaults
} from './pet-bundle'
import { readRasterImageDimensions } from '../../shared/raster-image-dimensions'

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value, 0)
  return buffer
}

function u24(value: number): Buffer {
  return Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff])
}

function webpVp8x(width: number, height: number): Buffer {
  const payload = Buffer.concat([Buffer.from([0, 0, 0, 0]), u24(width - 1), u24(height - 1)])
  return Buffer.concat([
    Buffer.from('RIFF'),
    u32(4 + 8 + payload.byteLength),
    Buffer.from('WEBP'),
    Buffer.from('VP8X'),
    u32(payload.byteLength),
    payload
  ])
}

describe('applyCodexPetDefaults', () => {
  it('fills Codex pet manifests that omit Orca sprite metadata', () => {
    const manifest = applyCodexPetDefaults({ id: 'apupepe', displayName: 'Pepe' })

    expect(manifest.spritesheetPath).toBe(CODEX_PET_SPRITESHEET_PATH)
    expect(manifest.frame).toEqual(CODEX_PET_FRAME)
    expect(manifest.defaultAnimation).toBe('idle')
    expect(manifest.animations).toEqual(CODEX_PET_ANIMATIONS)
    expect(Object.keys(manifest.animations ?? [])).toEqual([
      'idle',
      'running-right',
      'running-left',
      'waving',
      'jumping',
      'failed',
      'waiting',
      'running',
      'review'
    ])
  })

  it('fills Codex pet manifests that declare only spritesheetPath', () => {
    const manifest = applyCodexPetDefaults({
      id: 'itachi',
      displayName: 'Itachi',
      spritesheetPath: 'spritesheet.webp'
    })

    expect(manifest.spritesheetPath).toBe(CODEX_PET_SPRITESHEET_PATH)
    expect(manifest.frame).toEqual(CODEX_PET_FRAME)
    expect(manifest.defaultAnimation).toBe('idle')
    expect(manifest.animations).toEqual(CODEX_PET_ANIMATIONS)
  })

  it('bakes uniform per-frame durations when a Codex-layout bundle pins an explicit fps', () => {
    // The requested fps is baked as durations so it is honored rather than
    // overridden by the timed table, and so the sprite never enters the
    // no-durations legacy retiming path.
    const manifest = applyCodexPetDefaults({ id: 'zippy', displayName: 'Zippy', fps: 4 })

    expect(manifest.fps).toBe(4)
    // 4 fps → 250ms per frame; idle keeps its six frames.
    expect(manifest.animations?.idle).toEqual({
      row: 0,
      frames: 6,
      frameDurationsMs: [250, 250, 250, 250, 250, 250]
    })
  })

  it('keeps an explicit fps=8 bundle out of the legacy retiming path', () => {
    // fps=8 matches the Codex default and the legacy geometry, but baking
    // durations makes it a non-match so the uniform pacing is preserved.
    const manifest = applyCodexPetDefaults({ id: 'octo', displayName: 'Octo', fps: 8 })
    const sprite = {
      frameWidth: 192,
      frameHeight: 208,
      columns: 8,
      rows: 9,
      sheetWidth: 1536,
      sheetHeight: 1872,
      fps: 8,
      defaultAnimation: 'idle',
      animations: manifest.animations
    }
    expect(applyCodexSpriteTimingDefaults(sprite)).toBe(sprite)
    expect(sprite.animations?.idle.frameDurationsMs).toEqual([125, 125, 125, 125, 125, 125])
  })

  it('does not override explicit Orca bundle sprite metadata', () => {
    const manifest = applyCodexPetDefaults({
      spritesheetPath: 'custom.png',
      frame: { width: 64, height: 64 },
      fps: 12,
      defaultAnimation: 'blink',
      animations: { blink: { row: 0, frames: 2 } }
    })

    expect(manifest).toEqual({
      spritesheetPath: 'custom.png',
      frame: { width: 64, height: 64 },
      fps: 12,
      defaultAnimation: 'blink',
      animations: { blink: { row: 0, frames: 2 } }
    })
  })

  it('defaults only spritesheetPath when explicit sprite metadata is present', () => {
    const manifest = applyCodexPetDefaults({
      frame: { width: 64, height: 64 },
      animations: { blink: { row: 0, frames: 2 } }
    })

    expect(manifest.spritesheetPath).toBe(CODEX_PET_SPRITESHEET_PATH)
    expect(manifest.frame).toEqual({ width: 64, height: 64 })
    expect(manifest.animations).toEqual({ blink: { row: 0, frames: 2 } })
    expect(manifest.defaultAnimation).toBeUndefined()
  })
})

describe('readRasterImageDimensions', () => {
  it('reads VP8X WebP canvas dimensions without decoding pixels', () => {
    expect(readRasterImageDimensions(webpVp8x(1536, 1872))).toEqual({
      width: 1536,
      height: 1872
    })
  })

  it('returns null for non-WebP data', () => {
    expect(readRasterImageDimensions(Buffer.from('not an image'))).toBeNull()
  })

  it('reads PNG and GIF dimensions without decoding pixels', () => {
    const png = Buffer.alloc(24)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
    png.writeUInt32BE(13, 8)
    png.write('IHDR', 12, 'ascii')
    png.writeUInt32BE(8192, 16)
    png.writeUInt32BE(512, 20)
    const gif = Buffer.alloc(10)
    gif.write('GIF89a', 0, 'ascii')
    gif.writeUInt16LE(320, 6)
    gif.writeUInt16LE(240, 8)

    expect(readRasterImageDimensions(png)).toEqual({ width: 8192, height: 512 })
    expect(readRasterImageDimensions(gif)).toEqual({ width: 320, height: 240 })
  })

  it('reads JPEG dimensions without decoding pixels', () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x10, 0x00, 0x20, 0x00, 0x03, 0x01, 0x11, 0x00,
      0x02, 0x11, 0x00, 0x03, 0x11, 0x00
    ])

    expect(readRasterImageDimensions(jpeg)).toEqual({ width: 8192, height: 4096 })
  })
})
