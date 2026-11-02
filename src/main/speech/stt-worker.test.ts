import { describe, expect, it } from 'vitest'
import { resampleToRate } from './stt-audio-resample'

describe('resampleToRate', () => {
  it('resamples changing capture rates onto the same 16 kHz timeline', () => {
    const first = resampleToRate(
      Float32Array.from({ length: 480 }, (_, index) => index / 480),
      48000,
      16000
    )
    const second = resampleToRate(
      Float32Array.from({ length: 441 }, (_, index) => index / 441),
      44100,
      16000
    )

    expect(first).toHaveLength(160)
    expect(second).toHaveLength(160)
    expect(first[1]).toBeCloseTo(0.00625, 6)
    expect(first[80]).toBeCloseTo(0.5, 6)
    expect(second[1]).toBeCloseTo(0.00625, 6)
    expect(second[80]).toBeCloseTo(0.5, 6)
  })

  it('keeps same-rate chunks unchanged', () => {
    const samples = new Float32Array([0, 0.5, -0.5])

    expect(resampleToRate(samples, 16000, 16000)).toBe(samples)
  })
})
