import { expect, it, vi } from 'vitest'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { PROTOCOL_VERSION, type SessionInfo } from './types'

it('reports the router fence as closed admission while its census is still pending', async () => {
  const { DaemonPtyRouter } = await import('./daemon-pty-router')
  const { installDaemonProvider, isDaemonTerminalAdmissionClosed } =
    await import('./daemon-provider-state')
  const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
  const census = Promise.withResolvers<SessionInfo[]>()
  vi.mocked(current.listSessions).mockReturnValueOnce(census.promise)
  const router = new DaemonPtyRouter({ current, legacy: [] })
  installDaemonProvider(null, router)

  const retiring = router.requestIdleRetirement()
  expect(current.isIdleRetirementAdmissionClosed()).toBe(false)
  expect(isDaemonTerminalAdmissionClosed()).toBe(true)
  census.resolve([])
  await retiring
})
