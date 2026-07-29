import { describe, expect, it } from 'vitest'
import {
  buildCodexMicroLightingSnapshot,
  parseCodexMicroLightingSnapshot
} from './lighting-snapshot'

describe('buildCodexMicroLightingSnapshot', () => {
  it('encodes bounded brightness, RGB strings, and six slot IDs', () => {
    const snapshot = buildCodexMicroLightingSnapshot({
      enabled: true,
      brightness: 75,
      ambientColor: 0x12abef,
      keyColor: 0x010203
    })

    expect(snapshot.rgbcfg).toEqual({
      ambient: { e: 1, b: 0.75, s: 0, m: 0, c: '0x12abef' },
      keys: { e: 1, b: 0.75, s: 0, m: 0, c: '0x010203' }
    })
    expect(snapshot.thstatus.map((slot) => slot.id)).toEqual([0, 1, 2, 3, 4, 5])
    expect(snapshot.thstatus.every((slot) => slot.c === '0x010203')).toBe(true)
  })

  it('emits a reversible off snapshot', () => {
    const snapshot = buildCodexMicroLightingSnapshot({ enabled: false, brightness: 999 })
    expect(snapshot.rgbcfg.ambient).toEqual({ e: 0, b: 0, s: 0, m: 0, c: '0x000000' })
    expect(snapshot.thstatus.every((slot) => slot.b === 0 && slot.e === 0)).toBe(true)
  })

  it('rejects partial, extra-field, and malformed wire snapshots', () => {
    const valid = buildCodexMicroLightingSnapshot({ enabled: true, brightness: 50 })
    expect(parseCodexMicroLightingSnapshot(valid)).toEqual(valid)
    expect(
      parseCodexMicroLightingSnapshot({ rgbcfg: valid.rgbcfg, thstatus: [{ id: 0 }] })
    ).toBeNull()
    expect(
      parseCodexMicroLightingSnapshot({
        ...valid,
        rgbcfg: { ...valid.rgbcfg, ambient: { ...valid.rgbcfg.ambient, raw: true } }
      })
    ).toBeNull()
    expect(
      parseCodexMicroLightingSnapshot({
        ...valid,
        thstatus: valid.thstatus.map((slot, id) => (id === 5 ? { ...slot, c: '../bad' } : slot))
      })
    ).toBeNull()
  })
})
