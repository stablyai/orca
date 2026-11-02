import { describe, expect, it } from 'vitest'
import { classifyRuntimeLongPoll } from './runtime-rpc-long-poll'

describe('required setup long polls', () => {
  it('keeps a linked native create alive while ordinary creates remain short calls', () => {
    const request = { id: 'setup', authToken: 'token', method: 'agentSession.create' }
    expect(classifyRuntimeLongPoll({ ...request, params: { afterWorktreeSetup: true } })).toBe(
      'wait'
    )
    expect(classifyRuntimeLongPoll({ ...request, params: {} })).toBeNull()
  })
})
