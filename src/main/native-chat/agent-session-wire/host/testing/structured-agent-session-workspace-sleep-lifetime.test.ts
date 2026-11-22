import { expect, it, vi } from 'vitest'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data.test-fixture'
import { attach, hostTestState } from './structured-agent-session-host.test-fixture'

it('omits an unproven workspace child from the stop receipt', async () => {
  const { host, store } = hostTestState()
  await attach()
  host.deps.adapter.closeSession = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)

  expect(await host.sleepWorkspace('workspace-1', true)).toEqual({
    stoppedSessionIds: [],
    failures: [{ sessionId: SESSION, reason: 'stop-unverifiable' }]
  })
  expect(store.getRecord(SESSION)).not.toBeNull()
  expect(store.getRecord(SESSION)?.sleptAt).toBeUndefined()
})

// Startup runs outside serialization; Sleep must reach it through its abort.
