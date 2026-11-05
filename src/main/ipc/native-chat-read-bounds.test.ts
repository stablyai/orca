import { describe, expect, it } from 'vitest'
import { nativeChatReadSessionBounds } from './native-chat-read-bounds'

describe('nativeChatReadSessionBounds', () => {
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
})
