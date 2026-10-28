import { describe, expect, it, vi } from 'vitest'

const stopSpeaking = vi.fn()
vi.mock('./reply-speaker', () => ({ stopSpeaking }))

const { isAutoReadMuted, setAutoReadMuted } = await import('./auto-read-mute')

describe('auto-read mute', () => {
  it('starts unmuted and stops the reading when muted', () => {
    expect(isAutoReadMuted()).toBe(false)
    setAutoReadMuted(true)
    expect(isAutoReadMuted()).toBe(true)
    expect(stopSpeaking).toHaveBeenCalledTimes(1)
    setAutoReadMuted(false)
    expect(isAutoReadMuted()).toBe(false)
    expect(stopSpeaking).toHaveBeenCalledTimes(1)
  })
})
