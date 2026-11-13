import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileDictationAutoSend } from './mobile-dictation-auto-send'

describe('MobileDictationAutoSend', () => {
  let autoSend: MobileDictationAutoSend
  let sent: string[]
  let stale: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    autoSend = new MobileDictationAutoSend()
    sent = []
    stale = autoSend.register('chat-a', () => sent.push('chat-a'))
    autoSend.sendsTo('session-1')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends a dictated chat message once when its countdown ends', () => {
    autoSend.arm('chat-a', 2000)
    expect(autoSend.start({ partial: false })?.scope).toBe('chat-a')
    vi.advanceTimersByTime(2000)
    expect(autoSend.start({ partial: false })).toBeNull()
    vi.advanceTimersByTime(2000)
    expect(sent).toEqual(['chat-a'])
  })

  it("keeps a failed dictation's words so far as a draft", () => {
    autoSend.arm('chat-a', 2000)
    expect(autoSend.start({ partial: true })).toBeNull()
    vi.advanceTimersByTime(2000)
    expect(sent).toEqual([])
  })

  it('keeps the draft when the agent session behind the chat is replaced mid-countdown', () => {
    autoSend.arm('chat-a', 2000)
    autoSend.start({ partial: false })
    autoSend.sendsTo('session-2')
    vi.advanceTimersByTime(2000)
    expect(sent).toEqual([])
  })

  it("keeps the countdown when a newer composer for the same chat replaces the old one's Send", () => {
    const replaced = autoSend.register('chat-a', () => sent.push('newer'))
    autoSend.arm('chat-a', 2000)
    autoSend.start({ partial: false })
    stale()
    vi.advanceTimersByTime(2000)
    expect(sent).toEqual(['newer'])
    replaced()
  })

  it('never sends a draft whose composer has no Send of its own, like a queued-message edit', () => {
    autoSend.arm('queued-edit:1', 2000)
    expect(autoSend.start({ partial: false })).toBeNull()
    vi.advanceTimersByTime(2000)
    expect(sent).toEqual([])
  })
})
