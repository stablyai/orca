import { describe, expect, it, vi } from 'vitest'
import { CodexControlledSessionDisposalFence } from './codex-controlled-session-disposal-fence'

describe('CodexControlledSessionDisposalFence', () => {
  it.each(['conversation', 'registry'] as const)(
    'drains a gated launch before %s disposal returns',
    async (scope) => {
      let releaseLaunch: (() => void) | undefined
      const launch = new Promise<void>((resolve) => {
        releaseLaunch = resolve
      })
      const disposeSession = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
      const fence = new CodexControlledSessionDisposalFence(
        () => launch,
        () => ['conversation-1'],
        disposeSession
      )
      const disposal =
        scope === 'conversation' ? fence.disposeConversation('conversation-1') : fence.dispose()

      expect(() => fence.assertNotDisposing('conversation-1')).toThrow(
        'controlled Codex session is disposing'
      )
      releaseLaunch?.()

      await expect(disposal).resolves.toBeUndefined()
      expect(disposeSession).toHaveBeenCalledWith('conversation-1')
    }
  )
})
