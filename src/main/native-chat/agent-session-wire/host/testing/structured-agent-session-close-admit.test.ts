// An automatic worker close decides in the session lane, ordered after any send admitted before it.

import { expect, it } from 'vitest'
import { attach, hostTestState } from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

it('leaves the chat running when the close is refused in the session lane', async () => {
  const { host } = hostTestState()
  await attach()

  await expect(host.close(SESSION, 'evict', () => false)).rejects.toThrow('kept this chat')
  expect(host.hasSession(SESSION)).toBe(true)

  await host.close(SESSION, 'evict', () => true)
  expect(host.hasSession(SESSION)).toBe(false)
})
