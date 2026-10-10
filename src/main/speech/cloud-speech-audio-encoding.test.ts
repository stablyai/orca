import { describe, expect, it } from 'vitest'
import { BatchDictationAudioBuffer, CloudAudioResampler } from './cloud-speech-audio-encoding'
import { resampleToRate } from './stt-audio-resample'

describe('BatchDictationAudioBuffer', () => {
  it('refuses an unsupported sample rate before resampling', () => {
    const buffer = new BatchDictationAudioBuffer()

    expect(() => buffer.append(new Float32Array(4096), 1e-6)).toThrow(
      'Unsupported audio sample rate'
    )
    expect(buffer.isEmpty()).toBe(true)
  })

  it('checks the duration cap against the incoming chunk before allocating it', () => {
    const buffer = new BatchDictationAudioBuffer()
    buffer.append(new Float32Array(16_000 * 60 * 9), 16_000)

    expect(() => buffer.append(new Float32Array(8_000 * 61), 8_000)).toThrow(
      'limited to 10 minutes'
    )
    buffer.append(new Float32Array(48_000 * 59), 48_000)
    expect(buffer.isEmpty()).toBe(false)
  })
})

describe('CloudAudioResampler', () => {
  function sine(length: number, sampleRate: number): Float32Array {
    const samples = new Float32Array(length)
    for (let i = 0; i < length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate)
    }
    return samples
  }

  it('keeps the fractional phase across 48 kHz capture chunks', () => {
    const input = sine(4096 * 2, 48_000)
    const resampler = new CloudAudioResampler()

    const first = resampler.push(input.subarray(0, 4096), 48_000)
    const second = resampler.push(input.subarray(4096), 48_000)
    const streamed = new Float32Array([...first, ...second])
    const oneShot = resampleToRate(input, 48_000, 16_000)

    expect(Math.abs(streamed.length - 2731)).toBeLessThanOrEqual(1)
    expect(Math.abs(streamed.length - oneShot.length)).toBeLessThanOrEqual(1)
    const compared = Math.min(streamed.length, oneShot.length)
    for (let i = 0; i < compared; i += 1) {
      expect(streamed[i]).toBeCloseTo(oneShot[i], 5)
    }
  })

  it('does not drift over ten minutes of 4096-sample chunks', () => {
    const resampler = new CloudAudioResampler()
    const chunk = new Float32Array(4096)
    const chunkCount = Math.ceil((48_000 * 600) / 4096)
    let produced = 0
    for (let i = 0; i < chunkCount; i += 1) {
      produced += resampler.push(chunk, 48_000).length
    }

    expect(Math.abs(produced - (chunkCount * 4096) / 3)).toBeLessThanOrEqual(1)
  })

  it('interpolates across chunk seams when upsampling', () => {
    const input = sine(300, 8_000)
    const resampler = new CloudAudioResampler()

    const streamed = new Float32Array([
      ...resampler.push(input.subarray(0, 101), 8_000),
      ...resampler.push(input.subarray(101, 102), 8_000),
      ...resampler.push(input.subarray(102), 8_000)
    ])
    const oneShot = resampleToRate(input, 8_000, 16_000)

    // Only the outputs past the final input sample wait for audio that never comes.
    expect(oneShot.length - streamed.length).toBe(2)
    for (let i = 0; i < Math.min(streamed.length, oneShot.length); i += 1) {
      expect(streamed[i]).toBeCloseTo(oneShot[i], 5)
    }
  })

  it('restarts the phase when the capture rate changes', () => {
    const resampler = new CloudAudioResampler()
    resampler.push(new Float32Array(4097), 48_000)

    expect(resampler.push(new Float32Array(441), 44_100).length).toBe(160)
  })

  it('refuses an unsupported sample rate', () => {
    expect(() => new CloudAudioResampler().push(new Float32Array(16), 1e9)).toThrow(
      'Unsupported audio sample rate'
    )
  })
})

describe('BatchDictationAudioBuffer resampling', () => {
  it('buffers the same sample count as one-shot resampling of the whole dictation', () => {
    const buffer = new BatchDictationAudioBuffer()
    for (let i = 0; i < 2; i += 1) {
      buffer.append(new Float32Array(4096), 48_000)
    }

    const wav = buffer.takeWav()
    const samples = (wav.length - 44) / 2
    expect(Math.abs(samples - 2731)).toBeLessThanOrEqual(1)
  })
})
