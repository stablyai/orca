// A share link closed from inside its own change callback keeps nothing running: no settle timer
// outlives it, and the dial it was awaiting settles as unpaired.
import { afterEach, expect, it, vi } from 'vitest'

vi.mock(
  '../../ipc/runtime-environments/connections/runtime-environment-request-connections',
  () => ({
    closeRemoteRuntimeRequestConnection: () => {},
    ensureRemoteRuntimeSharedControlConnection: () => {},
    getRemoteRuntimeSharedControlDiagnostics: () => null,
    reconnectRemoteRuntimeSharedControlConnection: () => {},
    sendRemoteRuntimeSharedControlRequest: () => Promise.reject(new Error('unused'))
  })
)
vi.mock('../../ipc/runtime-environments/connections/runtime-environment-relay-link', () => ({
  clearRelayDialHolds: () => {}
}))
vi.mock('../../ipc/runtime-environments/status/runtime-environment-diagnostics-broadcast', () => ({
  onRuntimeEnvironmentDiagnostics: () => () => {}
}))
vi.mock('../../../shared/remote-runtime/pairing/shared-host-keys', () => ({
  sharedHostEnvironment: () => ({ id: 'env-1' })
}))
vi.mock('../../../shared/remote-runtime/host-catalog/runtime-environments', () => ({
  getPreferredPairedRuntimeConnection: () => ({ endpoint: 'orca-relay:x' })
}))

const { sharedBotHostLink } = await import('./shared-bot-host-link')

afterEach(() => vi.useRealTimers())

it('leaves no timer running when its change callback closes it mid-dial', async () => {
  vi.useFakeTimers()
  const link: ReturnType<typeof sharedBotHostLink> = sharedBotHostLink({
    environmentId: 'env-1',
    hasCredential: () => true,
    onLinkChanged: (next) => {
      if (next === 'connecting') {
        link.close()
      }
    }
  })
  const dialed = link.connect()
  expect(await dialed).toBe('unpaired')
  expect(link.current()).toBe('unpaired')
  expect(vi.getTimerCount()).toBe(0)
})
