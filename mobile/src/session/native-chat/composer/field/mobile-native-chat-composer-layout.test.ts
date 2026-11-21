import { describe, expect, it } from 'vitest'
import { mobileNativeChatComposerShowsStop } from './mobile-native-chat-composer-layout'

// A send clears the draft as it starts; while the agent works, Stop must not take Send's place until it settles.
const working = {
  canStop: true,
  sendBlocked: false,
  canSend: false,
  editing: false,
  draft: '',
  attachmentCount: 0
}

describe('mobileNativeChatComposerShowsStop', () => {
  it('keeps Send while its own send is out, then offers Stop', () => {
    expect(mobileNativeChatComposerShowsStop({ ...working, sending: true })).toBe(false)
    expect(mobileNativeChatComposerShowsStop({ ...working, sending: false })).toBe(true)
  })
})
