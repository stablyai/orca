// The share link's dial outside the real connection: what settles it, and that a link closed
// from inside its own change callback keeps nothing running.
import { afterEach, expect, it, vi } from 'vitest'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../shared/remote-runtime/control/remote-runtime-shared-control-types'

type Edge = {
  listener: ((event: { environmentId: string; diagnostics: { state: string } }) => void) | null
}

const edge = vi.hoisted((): Edge => ({ listener: null }))

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
  onRuntimeEnvironmentDiagnostics: (listener: NonNullable<typeof edge.listener>) => {
    edge.listener = listener
    return () => {}
  }
}))
vi.mock('../../../shared/remote-runtime/pairing/shared-host-keys', () => ({
  sharedHostEnvironment: () => ({ id: 'env-1' })
}))
vi.mock('../../../shared/remote-runtime/host-catalog/runtime-environments', () => ({
  getPreferredPairedRuntimeConnection: () => ({ endpoint: 'orca-relay:x' })
}))

const { sharedBotHostLink } = await import('./shared-bot-host-link')

afterEach(() => {
  vi.useRealTimers()
  edge.listener = null
})

const publish = (state: RemoteRuntimeSharedConnectionDiagnostics['state']) =>
  edge.listener?.({ environmentId: 'env-1', diagnostics: { state } })

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
  expect(await link.connect()).toBe('unpaired')
  expect(link.current()).toBe('unpaired')
  expect(vi.getTimerCount()).toBe(0)
})

it('settles at once as unpaired when the opener refuses with no credential left', async () => {
  vi.useFakeTimers()
  const link = sharedBotHostLink({
    environmentId: 'env-1',
    hasCredential: () => false,
    onLinkChanged: () => {}
  })
  const dialed = link.connect()
  // Refused before it ever reached the host: no attempt seen, and nothing to wait out.
  publish('closed')
  expect(await dialed).toBe('unpaired')
  expect(vi.getTimerCount()).toBe(0)
})
