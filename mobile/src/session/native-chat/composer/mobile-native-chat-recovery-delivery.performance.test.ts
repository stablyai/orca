import { expect, it, vi } from 'vitest'
import * as inFlight from './delivery/mobile-native-chat-in-flight-sends'
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
    let visits = 0
    const sends = Array.from({ length: 1000 }, (_, index): MobileNativeChatInFlightSend => ({
      id: `saved-${index}`,
      clientMessageId: `message-${index}`,
      sessionId,
      get kind(): 'structured' {
        visits += 1
        return 'structured'
      },
      text: 'Task',
      normalizedText: 'Task',
      skills: [],
      images: [],
      files: [],
      baselineTailMessageId: null
    }))
    const scope = `recovery-${sessionId}`
    inFlight.registerSavedMobileNativeChatInFlightSends(scope, sends)
    // Rebuilding every draft's growing send array made recovery quadratic.
    const groupSends = vi.spyOn(inFlight, 'readMobileNativeChatInFlightSendsByScope')
    try {
      settleMobileInstructionRecovery(
        'active',
        [{ clientMessageId: 'message-0', dispatchState: 'pending', reason: null }],
        () => {},
        []
      )
      expect(visits).toBe(1000)
      expect(groupSends).not.toHaveBeenCalled()
    } finally {
      groupSends.mockRestore()
      inFlight.retireMobileNativeChatInFlightSends(scope)
    }
  }
)
