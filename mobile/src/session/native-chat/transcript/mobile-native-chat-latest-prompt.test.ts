import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { mobileNativeChatLatestPrompt } from './mobile-native-chat-latest-prompt'

const user = (id: string): NativeChatMessage => ({
  id,
  role: 'user',
  blocks: [{ type: 'text', text: 'go' }],
  source: 'transcript',
  timestamp: null
})

it('skips tool results and queued prompts', () => {
  expect(
    mobileNativeChatLatestPrompt([
      user('u1'),
      { ...user('a1'), role: 'assistant' },
      { ...user('r1'), blocks: [{ type: 'tool-result', callId: 'c1', output: 'ok' }] },
      { ...user('u2'), queued: true }
    ])?.id
  ).toBe('u1')
})

it('does not jump past a pending prompt', () => {
  expect(
    mobileNativeChatLatestPrompt([
      user('u1'),
      { ...user('a1'), role: 'assistant' },
      { ...user('u2'), pendingSend: 'active' }
    ])
  ).toBeNull()
})
