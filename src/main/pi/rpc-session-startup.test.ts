import { afterEach, describe, expect, it } from 'vitest'
import {
  closePiRpcAdapterFixtures,
  restart,
  sessionId,
  setup,
  state
} from './rpc-session-adapter.test-fixture'

afterEach(closePiRpcAdapterFixtures)

describe('Pi host awaited open', () => {
  it('fails an open if its lane fails while the state request is pending', async () => {
    const h = await setup()
    const stateReply = Promise.withResolvers<unknown>()
    const { acquired, child } = await restart(h, (connection) => {
      connection.requestOverride = (command) =>
        command === 'get_state' ? stateReply.promise : undefined
    })
    const opening = h.adapter.open({
      sessionId,
      fence: 8,
      acquisitionGeneration: acquired.acquisitionGeneration ?? null,
      signal: new AbortController().signal
    })
    child.handlers.onClose?.(new Error('lane failed during startup'))
    stateReply.resolve(state)
    await expect(opening).rejects.toThrow('lane failed during startup')
  })
})
