import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite,
  resetMobileNativeChatTerminalWritesForTests
} from './mobile-native-chat-terminal-write-lock'

describe('mobile-native-chat-terminal-write-lock', () => {
  afterEach(resetMobileNativeChatTerminalWritesForTests)

  it('allows composed writes on different terminals to proceed concurrently', () => {
    expect(acquireMobileNativeChatTerminalWrite('terminal-a')).toBe(true)

    expect(acquireMobileNativeChatTerminalWrite('terminal-b')).toBe(true)
    expect(acquireMobileNativeChatTerminalWrite('terminal-a')).toBe(false)

    releaseMobileNativeChatTerminalWrite('terminal-a')
    releaseMobileNativeChatTerminalWrite('terminal-b')
  })
})
