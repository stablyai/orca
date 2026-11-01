import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  call,
  clearStructuredHostStub,
  envelope,
  hostCalls,
  installStructuredHostStub,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(() => {
  installStructuredHostStub()
})
afterEach(() => {
  clearStructuredHostStub()
})

describe('rewind wire boundary', () => {
  it('routes the exact item and epoch through the structured capability gate', async () => {
    const params = { envelope: envelope(), itemId: 'chosen', expectedEpoch: 'current' }
    const result = await call('agentSession.rewind', params, STRUCTURED_CLIENT)
    expect(result).toMatchObject({ result: { ok: true } })
    expect(hostCalls.rewind).toHaveBeenCalledWith(expect.anything(), params)
  })
  it('rejects absent epoch and caller-supplied provider keys', async () => {
    for (const params of [
      { envelope: envelope(), itemId: 'chosen' },
      { envelope: envelope(), itemId: 'chosen', expectedEpoch: 'current', beforeTurnId: 'forged' }
    ]) {
      expect(await call('agentSession.rewind', params, STRUCTURED_CLIENT)).toHaveProperty('error')
    }
    expect(hostCalls.rewind).not.toHaveBeenCalled()
  })
})
