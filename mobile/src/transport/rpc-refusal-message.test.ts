import { describe, expect, it } from 'vitest'
import { summarizeCommitFailure } from '../../../src/shared/source-control-commit-failure'
import { hostReplyErrorTextOrFallback, refusedRpcMessageOrFallback } from './rpc-refusal-message'

describe('refusedRpcMessageOrFallback', () => {
  it('falls back for a message-less refusal and for a non-Error throw', () => {
    const messageless = new Error('cleared below')
    messageless.message = ''
    expect(refusedRpcMessageOrFallback(new Error('refused'), 'Commit failed')).toBe('refused')
    expect(refusedRpcMessageOrFallback(messageless, 'Commit failed')).toBe('Commit failed')
    expect(refusedRpcMessageOrFallback('refused', 'Commit failed')).toBe('Commit failed')
  })
})

describe('hostReplyErrorTextOrFallback', () => {
  it('keeps a non-empty host string', () => {
    expect(hostReplyErrorTextOrFallback('nothing staged', 'Commit failed')).toBe('nothing staged')
  })

  it('falls back for an absent, null or empty host error', () => {
    expect(hostReplyErrorTextOrFallback(undefined, 'Commit failed')).toBe('Commit failed')
    expect(hostReplyErrorTextOrFallback(null, 'Commit failed')).toBe('Commit failed')
    expect(hostReplyErrorTextOrFallback('', 'Commit failed')).toBe('Commit failed')
  })

  it('falls back for a truthy non-string, which the host contract does not allow', () => {
    expect(hostReplyErrorTextOrFallback({ message: 'inner refused' }, 'Commit failed')).toBe(
      'Commit failed'
    )
    expect(hostReplyErrorTextOrFallback(['a'], 'Commit failed')).toBe('Commit failed')
    expect(hostReplyErrorTextOrFallback(7, 'Commit failed')).toBe('Commit failed')
    expect(hostReplyErrorTextOrFallback(true, 'Commit failed')).toBe('Commit failed')
  })

  // The consumer that main's pass-through broke: `.slice` on an object, `.replace` on an array.
  it('yields text the commit-failure summarizer can read', () => {
    for (const malformed of [{ message: 'inner refused' }, ['inner refused'], 7]) {
      expect(summarizeCommitFailure(hostReplyErrorTextOrFallback(malformed, 'Commit failed'))).toBe(
        'Commit failed'
      )
    }
  })
})
