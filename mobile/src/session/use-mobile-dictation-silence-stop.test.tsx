import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMobileDictationMeter } from '../hooks/mobile-dictation-meter'
import { useMobileDictationSilenceStop } from './use-mobile-dictation-silence-stop'

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

function record(dictationMode: string) {
  const meter = createMobileDictationMeter()
  meter.start()
  const dictation = { isRecording: true, meter }
  const stop = vi.fn()
  const showToast = vi.fn()
  function Probe() {
    useMobileDictationSilenceStop(dictation, dictationMode, stop, showToast)
    return null
  }
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = create(createElement(Probe))
  })
  // Feed the mic the way the page shell drains it: 500 ms batches at the given amplitude.
  const play = (seconds: number, amplitude: number) => {
    for (let batch = 0; batch < seconds * 2; batch += 1) {
      act(() => {
        meter.push(pcm(500, amplitude))
        vi.advanceTimersByTime(500)
      })
    }
  }
  return { stop, showToast, play, unmount: () => act(() => renderer?.unmount()) }
}

describe('dictation silence stop', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('stops a tap-mode recording a minute after the last speech, not before', () => {
    const { stop, showToast, play, unmount } = record('toggle')
    play(40, 200)
    // Steady speech settles the meter, so its snapshot stops changing long before the speaker does.
    play(30, 12_000)
    play(59, 200)
    expect(stop).not.toHaveBeenCalled()
    play(2, 200)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('Stopped after a minute of silence')
    unmount()
  })

  it('counts a stalled audio stream as silence', () => {
    const { stop, play, unmount } = record('toggle')
    play(2, 12_000)
    act(() => {
      vi.advanceTimersByTime(61_000)
    })
    expect(stop).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('never stops a hold-mode recording', () => {
    const { stop, unmount } = record('hold')
    act(() => {
      vi.advanceTimersByTime(120_000)
    })
    expect(stop).not.toHaveBeenCalled()
    unmount()
  })
})
