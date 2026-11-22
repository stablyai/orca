import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMobileDictationMeter } from './mobile-dictation-meter'

// 16 kHz 16-bit little-endian PCM, as both shells deliver it.
function pcm(milliseconds: number, amplitude: number): Uint8Array {
  const samples = (16_000 * milliseconds) / 1000
  const bytes = new Uint8Array(samples * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(index * 2, index % 2 === 0 ? amplitude : -amplitude, true)
  }
  return bytes
}

describe('mobile dictation meter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('plays a 500 ms page drain back over the next half second instead of in one jump', () => {
    const meter = createMobileDictationMeter()
    meter.start()
    meter.push(new Uint8Array([...pcm(250, 0), ...pcm(250, 12_000)]))
    const levels: number[] = []
    for (let tick = 0; tick < 10; tick += 1) {
      vi.advanceTimersByTime(50)
      levels.push(meter.getSnapshot().level)
    }
    expect(levels.slice(0, 5).every((level) => level === 0)).toBe(true)
    expect(levels[9]).toBeGreaterThan(levels[5])
    expect(levels[5]).toBeGreaterThan(0)
    meter.stop()
  })

  it('reads the PCM as little-endian 16-bit, so full scale clips', () => {
    const meter = createMobileDictationMeter()
    meter.start()
    meter.push(pcm(32, 32_767))
    vi.advanceTimersByTime(50)
    expect(meter.getSnapshot().isClipping).toBe(true)
    meter.stop()
  })
})
