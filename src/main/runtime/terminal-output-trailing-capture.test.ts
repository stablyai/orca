import { describe, expect, it } from 'vitest'
import { TrailingTerminalOutputCapture } from './terminal-output-trailing-capture'

describe('snapshot trailing output continuity', () => {
  it('rejects a transformed chunk crossing the snapshot even if later output is contiguous', () => {
    const capture = new TrailingTerminalOutputCapture(0)
    capture.push('transformed', { seq: 10, rawLength: 10, transformed: true })
    capture.push('later', { seq: 15, rawLength: 5 })
    expect(capture.after(5)).toBeNull()
  })

  it('ignores covered transformed chunks and replays whole ones after the boundary', () => {
    const capture = new TrailingTerminalOutputCapture(0)
    capture.push('covered', { seq: 5, rawLength: 5, transformed: true })
    capture.push('uncovered', { seq: 10, rawLength: 5, transformed: true })
    expect(capture.after(5)).toEqual([{ data: 'uncovered', seq: 10 }])
  })

  it('slices an untransformed chunk crossing the boundary', () => {
    const capture = new TrailingTerminalOutputCapture(0)
    capture.push('abcdefghij', { seq: 10, rawLength: 10 })
    expect(capture.after(5)).toEqual([{ data: 'fghij', seq: 10 }])
  })
})
