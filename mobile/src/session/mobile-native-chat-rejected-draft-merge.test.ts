import { describe, expect, it } from 'vitest'
import { mergeRejectedDraftInto } from './mobile-native-chat-rejected-draft-merge'

describe('mergeRejectedDraftInto', () => {
  it('restores a rejected send into an empty composer verbatim', () => {
    expect(mergeRejectedDraftInto({ a: '' }, 'a', 'ping')).toEqual({ a: 'ping' })
  })

  it('restores into a composer key that does not exist yet', () => {
    expect(mergeRejectedDraftInto({}, 'a', 'ping')).toEqual({ a: 'ping' })
  })

  it('keeps both texts when the user typed while the rejection was in flight', () => {
    // The rejected send has no other surviving copy; skipping it loses the message.
    expect(mergeRejectedDraftInto({ a: 'newer edit' }, 'a', 'ping')).toEqual({
      a: 'ping\nnewer edit'
    })
  })

  it('does not duplicate a rejected send the composer already holds', () => {
    const drafts = { a: 'ping' }
    expect(mergeRejectedDraftInto(drafts, 'a', 'ping')).toBe(drafts)
  })

  it('preserves whitespace on both sides of the merge', () => {
    // Trailing whitespace is load-bearing: the host writes it onto the agent's
    // input line verbatim.
    expect(mergeRejectedDraftInto({ a: '  spaced  ' }, 'a', 'ping  ')).toEqual({
      a: 'ping  \n  spaced  '
    })
  })

  it('leaves other tabs untouched', () => {
    expect(mergeRejectedDraftInto({ a: '', b: 'other' }, 'a', 'ping')).toEqual({
      a: 'ping',
      b: 'other'
    })
  })
})
