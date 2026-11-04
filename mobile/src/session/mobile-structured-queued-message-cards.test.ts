import { describe, expect, it } from 'vitest'
import { activateMobileUiLocale } from '../i18n/mobile-i18n'
import { mobileQueuedMessageCards } from './mobile-structured-queued-message-cards'

describe('mobileQueuedMessageCards', () => {
  it('names command sources alongside agents in English and translated queued cards', async () => {
    const source = {
      kind: 'agent' as const,
      senders: [
        {
          name: null,
          party: { address: 'ci-notifier', terminalHandle: 'ci-notifier', orcaSessionId: null }
        },
        {
          name: 'Coder',
          party: { address: 'term_coder', terminalHandle: 'term_coder', orcaSessionId: null }
        }
      ],
      orchestration: null
    }
    const queued = {
      messageId: 'command-mail',
      position: 1,
      state: 'waiting' as const,
      body: {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'Background command completed' }],
        from: source
      }
    }
    const sourceOnly = {
      ...queued,
      messageId: 'command-only-mail',
      body: { ...queued.body, from: { ...source, senders: source.senders.slice(0, 1) } }
    }
    expect(
      mobileQueuedMessageCards([sourceOnly, queued], []).map((card) => card.attribution)
    ).toEqual(['From ci-notifier', 'From ci-notifier, Coder'])
    try {
      await activateMobileUiLocale('fr')
      expect(
        mobileQueuedMessageCards([sourceOnly, queued], []).map((card) => card.attribution)
      ).toEqual(['De la part de ci-notifier', 'De la part de ci-notifier, Coder'])
    } finally {
      await activateMobileUiLocale('en')
    }
  })
})
