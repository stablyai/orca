import { describe, expect, it } from 'vitest'
import { readCodexThreadId, readCodexThreadName } from './codex-structured-thread-facts'

describe('readCodexThreadName', () => {
  it('reads the name off the nested thread a start/resume/read reply carries', () => {
    expect(readCodexThreadName({ thread: { id: 't1', name: 'Fix the lease probe' } })).toBe(
      'Fix the lease probe'
    )
  })

  it('reads the envelope field a name-updated notification carries', () => {
    expect(readCodexThreadName({ threadId: 't1', threadName: 'Fix the lease probe' })).toBe(
      'Fix the lease probe'
    )
  })

  it('reads the snake_case spelling the session-configured event uses', () => {
    expect(readCodexThreadName({ thread_name: 'Fix the lease probe' })).toBe('Fix the lease probe')
  })

  it('reports null for an unnamed thread, a cleared name, and a non-object payload', () => {
    expect(readCodexThreadName({ thread: { id: 't1' } })).toBeNull()
    expect(readCodexThreadName({ threadId: 't1', threadName: '' })).toBeNull()
    expect(readCodexThreadName({ threadId: 't1', threadName: null })).toBeNull()
    expect(readCodexThreadName('thread-1')).toBeNull()
    expect(readCodexThreadName(null)).toBeNull()
  })
})

describe('readCodexThreadId', () => {
  it('reads the id off the nested thread and the camelCase envelope', () => {
    expect(readCodexThreadId({ thread: { id: 't1' } })).toBe('t1')
    expect(readCodexThreadId({ threadId: 't1' })).toBe('t1')
  })

  it('reads the snake_case spelling its sibling name reader already accepts', () => {
    // An envelope whose NAME is readable but whose ID is not would let
    // captureCodexConversationName's `?? session.threadId` fallback attribute
    // another thread's name to this chat and persist it.
    expect(readCodexThreadId({ thread_id: 't1', thread_name: 'Fix the lease probe' })).toBe('t1')
  })

  it('reports null for an unnamed envelope and a non-object payload', () => {
    expect(readCodexThreadId({ thread: {} })).toBeNull()
    expect(readCodexThreadId({ threadId: '' })).toBeNull()
    expect(readCodexThreadId('thread-1')).toBeNull()
    expect(readCodexThreadId(null)).toBeNull()
  })
})
