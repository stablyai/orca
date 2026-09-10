import { describe, expect, it } from 'vitest'
import {
  createMobileNativeChatDraftOwnership,
  reduceMobileNativeChatDraftOwnership as reduce
} from './mobile-native-chat-draft-ownership'
import type { MobileNativeChatSendOrigin } from './mobile-native-chat-pending-echo'

function origin(draftKey: string): MobileNativeChatSendOrigin {
  return {
    draftKey,
    pendingKey: null,
    normalizedText: 'draft',
    baselineOccurrences: 0,
    baselineTailMessageId: null,
    baselineResolved: true
  }
}

describe('mobile draft mutation ownership', () => {
  it('retains no fence state after 1000 completed scopes while preserving text', () => {
    let state = createMobileNativeChatDraftOwnership()
    const held = origin('remote\0folder\0held')
    state = reduce(state, { type: 'capture', origin: held })
    for (let i = 0; i < 1000; i++) {
      const send = origin(`host-${i}\0workspace-${i}\0tab-${i}`)
      state = reduce(state, { type: 'edit', draftKey: send.draftKey, value: 'draft' })
      state = reduce(state, { type: 'capture', origin: send })
      expect(state.origins.size).toBe(2)
      state = reduce(state, { type: 'clear', origin: send, text: 'draft' })
      state = reduce(state, { type: 'restore', origin: send, text: 'draft' })
      state = reduce(state, { type: 'release', origin: send })
      expect(state.origins.size).toBe(1)
    }
    expect(Object.values(state.drafts)).toEqual(Array(1000).fill('draft'))
    state = reduce(state, { type: 'restore', origin: held, text: 'held draft' })
    expect(state.drafts[held.draftKey]).toBe('held draft')
    state = reduce(state, { type: 'release', origin: held })
    expect(state.origins.size).toBe(0)
    expect(reduce(state, { type: 'release', origin: held })).toBe(state)
    expect(reduce(state, { type: 'clear', origin: held, text: 'held draft' })).toBe(state)
  })

  it('invalidates all same-scope sends on even an empty or rolled-back edit', () => {
    let state = createMobileNativeChatDraftOwnership()
    const a = origin('a'),
      b = origin('a'),
      other = origin('b')
    for (const send of [a, b, other]) {
      state = reduce(state, { type: 'capture', origin: send })
    }
    state = reduce(state, { type: 'edit', draftKey: 'a', value: 'newer' })
    state = reduce(state, { type: 'edit', draftKey: 'a', value: '' })
    expect([...state.origins]).toEqual([other])
    for (const send of [a, b]) {
      expect(reduce(state, { type: 'restore', origin: send, text: 'stale' })).toBe(state)
    }
    const reopened = origin('a')
    state = reduce(state, { type: 'capture', origin: reopened })
    state = reduce(state, { type: 'restore', origin: reopened, text: 'fresh' })
    expect(state.drafts.a).toBe('fresh')
    expect(reduce(state, { type: 'clear', origin: a, text: 'fresh' })).toBe(state)
  })

  it('releases concurrent sends independently and refuses foreign instance identities', () => {
    let state = createMobileNativeChatDraftOwnership()
    const a = origin('a'),
      b = origin('a')
    for (const send of [a, b]) {
      state = reduce(state, { type: 'capture', origin: send })
    }
    state = reduce(state, { type: 'release', origin: a })
    state = reduce(state, { type: 'restore', origin: b, text: 'survives' })
    expect(state.drafts.a).toBe('survives')
    expect(reduce(state, { type: 'clear', origin: { ...b }, text: 'survives' })).toBe(state)
    const fresh = createMobileNativeChatDraftOwnership()
    expect(reduce(fresh, { type: 'restore', origin: b, text: 'old instance' })).toBe(fresh)
  })
})
