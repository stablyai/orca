import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { retireLandedMobileNativeChatPending } from './mobile-native-chat-pending-retirement'

const boundary: NativeChatMessage = {
  id: 'boundary',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'before' }],
  timestamp: null,
  source: 'transcript'
}

// An old host still sends Claude's raw paste envelope; the shared normalizer must match it.
it('retires an echo against an old-host wrapped row and keeps the second identical send', () => {
  const text = 'one\ntwo'
  const echo: NativeChatMessage = {
    ...boundary,
    id: 'user',
    role: 'user',
    blocks: [{ type: 'text', text: `<pasted_content id="a">\n${text}\n</pasted_content id="a">` }]
  }
  const reply: NativeChatMessage = { ...boundary, id: 'reply' }
  const entry = {
    id: 'one',
    text,
    expectedOccurrence: 1,
    baselineTailMessageId: 'boundary',
    baselineResolved: true
  }
  expect(
    retireLandedMobileNativeChatPending(
      [boundary, echo, reply],
      [entry, { ...entry, id: 'two', expectedOccurrence: 2 }],
      new Set()
    ).map((item) => item.id)
  ).toEqual(['two'])
})
