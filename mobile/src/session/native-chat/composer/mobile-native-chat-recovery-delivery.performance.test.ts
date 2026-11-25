import { expect, it, vi } from 'vitest'
import {
  registerSavedMobileNativeChatInFlightSends,
  retireMobileNativeChatInFlightSends
} from './delivery/mobile-native-chat-in-flight-sends'
import { settleMobileInstructionRecovery } from './mobile-native-chat-recovery-delivery'
import type { MobileNativeChatInFlightSend } from './drafts/mobile-native-chat-saved-drafts'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('@react-native-async-storage/async-storage', async () => {
  const { createInMemoryAsyncStorage } =
    await import('../../../test-support/in-memory-async-storage')
  return { default: createInMemoryAsyncStorage() }
})

it.each(['active', 'elsewhere'])(
  'visits %s recovery sends without copying growing groups',
  (sessionId) => {
    const sends = Array.from({ length: 1000 }, (_, index): MobileNativeChatInFlightSend => ({
      id: `saved-${index}`,
      clientMessageId: `message-${index}`,
      sessionId,
      kind: 'structured',
      text: 'Task',
      normalizedText: 'Task',
      skills: [],
      images: [],
      files: [],
      baselineTailMessageId: null
    }))
    const markers = new Set<unknown>(sends)
    const scope = `recovery-${sessionId}`
    registerSavedMobileNativeChatInFlightSends(scope, sends)
    const iterate = Array.prototype[Symbol.iterator]
    let copied = 0
    try {
      Array.prototype[Symbol.iterator] = function (this: unknown[]) {
        if (markers.has(this[0])) {
          copied += this.length
        }
        return iterate.call(this)
      }
      settleMobileInstructionRecovery(
        'active',
        [{ clientMessageId: 'message-0', dispatchState: 'pending', reason: null }],
        () => {}
      )
    } finally {
      Array.prototype[Symbol.iterator] = iterate
      retireMobileNativeChatInFlightSends(scope)
    }
    expect(copied).toBeLessThanOrEqual(sends.length)
  }
)
