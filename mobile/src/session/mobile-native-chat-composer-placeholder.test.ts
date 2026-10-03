import { describe, expect, it } from 'vitest'
import { mobileNativeChatComposerPlaceholder } from './mobile-native-chat-composer-placeholder'

describe("the phone chat composer's placeholder", () => {
  it('says a message runs after the stop while the chat reads Stopping', () => {
    expect(mobileNativeChatComposerPlaceholder(null, 'queue')).toBe(
      'Queue a message to run after the stop'
    )
    // Where the host does not queue sends, it holds the message until the stop lands.
    expect(mobileNativeChatComposerPlaceholder(null, 'send')).toBe(
      'Send a message to run after the stop'
    )
  })

  it('reads as usual otherwise', () => {
    expect(mobileNativeChatComposerPlaceholder(null, undefined)).toBe('Message, @files, /commands')
  })

  it('says why the composer is locked first', () => {
    expect(mobileNativeChatComposerPlaceholder('disconnected', 'queue')).toBe('Reconnecting…')
    expect(mobileNativeChatComposerPlaceholder('waiting', 'queue')).toBe('Waiting for terminal…')
  })
})
