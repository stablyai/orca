import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import { equalMobileNativeChatRowContent as equal } from './mobile-native-chat-row-projection'

it('keeps opaque wide payloads out of comparison', () => {
  for (const width of [10, 100]) {
    const payload = Object.fromEntries(Array.from({ length: width }, (_, i) => [i, 'opaque']))
    const input = () =>
      new Proxy(payload, {
        ownKeys() {
          throw new Error('Opaque payload visited')
        }
      })
    const message: NativeChatMessage = {
      id: 'row',
      role: 'assistant',
      source: 'transcript',
      timestamp: 1,
      blocks: [{ type: 'tool-call', name: 'Read', input: input() }]
    }
    const before = { message, scope: 'chat', source: null }
    const replacement = {
      ...message,
      blocks: [{ type: 'tool-call' as const, name: 'Read', input: input() }]
    }
    expect(equal(before, { ...before, message: replacement })).toBe(false)
  }
})
