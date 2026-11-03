import { describe, expect, it } from 'vitest'
import { applyCodexSpriteTimingDefaults } from '../../shared/codex-pet-sprite-defaults'
import { applyCodexPetDefaults, readWebpDimensionsFromBuffer } from './pet-bundle'

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
  it('keeps an explicit fps=8 bundle out of the legacy retiming path', () => {
    // Even the default fps needs baked durations to preserve uniform pacing instead of legacy retiming.
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
})

describe('readWebpDimensionsFromBuffer', () => {
  it('reads VP8X WebP canvas dimensions without decoding pixels', () => {
    expect(readWebpDimensionsFromBuffer(webpVp8x(1536, 1872))).toEqual({
      width: 1536,
      height: 1872
    })
  })
})
