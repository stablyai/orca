import { describe, expect, it } from 'vitest'
import { sessionTabChatViewReplySchema } from './session-write-reply-schema'

describe('sessionTabChatViewReplySchema (RC-F3)', () => {
  it('reads known view modes and null', () => {
    for (const viewMode of ['terminal', 'chat', null]) {
      expect(
        sessionTabChatViewReplySchema.parse({ chatView: { viewMode, chatLeafId: null } }).chatView
          ?.viewMode
      ).toBe(viewMode)
    }
  })

  it('degrades a view mode this build does not know to undefined instead of refusing the reply', () => {
    const reply = sessionTabChatViewReplySchema.safeParse({
      chatView: { viewMode: 'split-view', chatLeafId: 'A' }
    })
    expect(reply.success).toBe(true)
    expect(reply.data?.chatView).toEqual({ viewMode: undefined, chatLeafId: 'A' })
  })

  it('still refuses a missing or non-string view mode', () => {
    expect(sessionTabChatViewReplySchema.safeParse({ chatView: { chatLeafId: 'A' } }).success).toBe(
      false
    )
    expect(
      sessionTabChatViewReplySchema.safeParse({ chatView: { viewMode: 3, chatLeafId: 'A' } })
        .success
    ).toBe(false)
  })
})
