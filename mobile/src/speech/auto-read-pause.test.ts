import { describe, expect, it, vi } from 'vitest'

const setAutoPlay = vi.fn()
vi.mock('./reply-speaker', () => ({ setAutoPlay }))

const { isAutoReadPaused, setAutoReadPaused } = await import('./auto-read-pause')

describe('auto-read pause', () => {
  it('starts resumed and turns the reader auto-play off and on', () => {
    expect(isAutoReadPaused()).toBe(false)
    setAutoReadPaused(true)
    expect(isAutoReadPaused()).toBe(true)
    expect(setAutoPlay).toHaveBeenLastCalledWith(false)
    setAutoReadPaused(true)
    expect(setAutoPlay).toHaveBeenCalledTimes(1)
    setAutoReadPaused(false)
    expect(isAutoReadPaused()).toBe(false)
    expect(setAutoPlay).toHaveBeenLastCalledWith(true)
  })
})
