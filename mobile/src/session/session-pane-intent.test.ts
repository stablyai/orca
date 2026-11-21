import { expect, it } from 'vitest'
import { sessionScreenIdentity } from './session-pane-intent'

it('keeps per-request params out of a session screen’s identity', () => {
  expect(
    sessionScreenIdentity({
      name: 'Chat',
      executionHost: 'runtime:server',
      paneKey: 'pane-1',
      botItem: '{"sessionId":"lead","itemId":"q-1"}',
      paneIntent: 'i-1'
    })
  ).toEqual({ name: 'Chat', executionHost: 'runtime:server' })
})
