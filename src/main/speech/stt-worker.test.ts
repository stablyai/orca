import { describe, expect, it } from 'vitest'
import { resampleToRate } from './stt-audio-resample'

describe('resampleToRate', () => {
  it('normalizes changing capture rates before audio enters the native recognizer', () => {
    const first = resampleToRate(new Float32Array(480), 48000, 16000)
    const second = resampleToRate(new Float32Array(441), 44100, 16000)

    expect(first).toHaveLength(160)
    expect(second).toHaveLength(160)
  })

  it('keeps same-rate chunks unchanged', () => {
    const samples = new Float32Array([0, 0.5, -0.5])

    expect(resampleToRate(samples, 16000, 16000)).toBe(samples)
  })
})
