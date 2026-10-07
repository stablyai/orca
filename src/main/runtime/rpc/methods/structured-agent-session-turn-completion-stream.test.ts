import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  openStream,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(() => installStructuredHostStub())
afterEach(() => clearStructuredHostStub())

describe('agentSession.subscribeTurnCompletions', () => {
  const subscribed = () => hostCalls.subscribeTurnCompletions.mock.calls.map(([sub]) => sub)

  it('opts a client into prompt edges only when it asks', async () => {
    await openStream('agentSession.subscribeTurnCompletions', {}, STRUCTURED_CLIENT)
    await openStream(
      'agentSession.subscribeTurnCompletions',
      { includePrompts: true },
      STRUCTURED_CLIENT
    )
    expect(subscribed().map((sub) => sub.includePrompts)).toEqual([false, true])
  })

  it("ignores a newer client's opt-in it does not know rather than refusing the stream", async () => {
    const replies = await openStream(
      'agentSession.subscribeTurnCompletions',
      { includePrompts: true, includeSomethingNewer: true },
      STRUCTURED_CLIENT
    )
    expect(replies.filter((reply) => !reply.ok)).toEqual([])
    expect(subscribed().map((sub) => sub.includePrompts)).toEqual([true])
  })
})
