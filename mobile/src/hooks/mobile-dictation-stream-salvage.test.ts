import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FAILED_STREAM_FINISH_GRACE_MS,
  createMobileDictationStreamSalvage
} from './mobile-dictation-stream-salvage'

const STREAM_FAILURE = new Error('dictation_stream_failed: Soniox closed the stream (1000).')

describe('mobile dictation stream salvage phases', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('ignores taps for a grace period, then lets them cancel a slow finish', () => {
    const phases: string[] = []
    const salvage = createMobileDictationStreamSalvage((phase) => phases.push(phase))
    expect(salvage.claim('d1', STREAM_FAILURE, async () => {})).toBe(true)
    expect(phases).toEqual(['grace'])

    vi.advanceTimersByTime(FAILED_STREAM_FINISH_GRACE_MS - 1)
    expect(phases).toEqual(['grace'])
    vi.advanceTimersByTime(1)
    expect(phases).toEqual(['grace', 'cancellable'])

    expect(salvage.take('d1')).toBe('Soniox closed the stream (1000).')
    expect(phases).toEqual(['grace', 'cancellable', 'none'])
  })

  it('stops the grace timer when the finish lands first', () => {
    const phases: string[] = []
    const salvage = createMobileDictationStreamSalvage((phase) => phases.push(phase))
    salvage.claim('d1', STREAM_FAILURE, null)
    salvage.take('d1')
    vi.advanceTimersByTime(FAILED_STREAM_FINISH_GRACE_MS)
    expect(phases).toEqual(['grace', 'none'])
  })

  it('drops a pending salvage when a later error cancels the dictation', () => {
    const phases: string[] = []
    const salvage = createMobileDictationStreamSalvage((phase) => phases.push(phase))
    salvage.claim('d1', STREAM_FAILURE, null)
    expect(salvage.claim('d1', new Error('Desktop disconnected.'), null)).toBe(false)
    vi.advanceTimersByTime(FAILED_STREAM_FINISH_GRACE_MS)
    expect(phases).toEqual(['grace', 'none'])
    expect(salvage.take('d1')).toBeNull()
  })

  it('reports nothing after dispose', () => {
    const onPhaseChange = vi.fn()
    const salvage = createMobileDictationStreamSalvage(onPhaseChange)
    salvage.claim('d1', STREAM_FAILURE, null)
    salvage.dispose()
    vi.advanceTimersByTime(FAILED_STREAM_FINISH_GRACE_MS)
    expect(onPhaseChange).toHaveBeenCalledTimes(1)
  })
})
