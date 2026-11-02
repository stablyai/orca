import { describe, expect, it } from 'vitest'
import { nativeChatReadSessionBounds } from './native-chat-read-bounds'

describe('nativeChatReadSessionBounds', () => {
  it('forwards a child id and a non-negative page offset', () => {
    expect(
      nativeChatReadSessionBounds({ beforeOffset: 12, subagentId: '/root/sample_greeting' })
    ).toEqual({
      beforeOffset: 12,
      subagentId: '/root/sample_greeting'
    })
  })

  it('rejects a child id that is not a short string instead of reading the parent', () => {
    expect(nativeChatReadSessionBounds({ subagentId: 4 })).toEqual({
      error: 'Transcript unavailable'
    })
    expect(nativeChatReadSessionBounds({ subagentId: '' })).toEqual({
      error: 'Transcript unavailable'
    })
    expect(nativeChatReadSessionBounds({ subagentId: 'x'.repeat(513) })).toEqual({
      error: 'Transcript unavailable'
    })
  })

  it('rejects an offset that is not a non-negative integer', () => {
    expect(nativeChatReadSessionBounds({ beforeOffset: -1 })).toEqual({
      error: 'Transcript unavailable'
    })
    expect(nativeChatReadSessionBounds({ beforeOffset: 1.5 })).toEqual({
      error: 'Transcript unavailable'
    })
  })
})
