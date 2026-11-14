import { stat } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import {
  observeTranscriptStat,
  transcriptObservationRetention,
  withTranscriptFsObservation
} from './transcript-fs-observation'

it.each([100, 1000])(
  'retains numeric facts, no settled Stats promises, for %i paths',
  async (n) => {
    const native = await stat('package.json')
    const read = vi.fn(async () => native)
    await withTranscriptFsObservation(async () => {
      for (let i = 0; i < n; i++) {
        await observeTranscriptStat(`/history/${i}`, read)
      }
      expect(transcriptObservationRetention()).toEqual({
        pending: 0,
        facts: n,
        numericBytes: n * 14 * 8
      })
      const reused = await observeTranscriptStat('/history/0', read)
      expect(reused).not.toBe(native)
      expect(reused.isFile()).toBe(native.isFile())
      expect(reused.mtime).toEqual(native.mtime)
      expect(reused.ino).toBe(native.ino)
      expect(reused.size).toBe(native.size)
      expect(read).toHaveBeenCalledTimes(n)
    })
    expect(transcriptObservationRetention()).toEqual({ pending: 0, facts: 0, numericBytes: 0 })
  }
)
