import { afterEach, expect, it, vi } from 'vitest'
import type { AuthenticatedRuntimeChannelEvents } from '../../../../shared/remote-runtime/control/remote-runtime-authenticated-channel'
import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { runtimeRelayEndpoint } from '../../../../shared/remote-runtime/pairing/runtime-relay-endpoint'
import { controlLinkOptions } from './runtime-environment-relay-link'

afterEach(() => vi.unstubAllEnvs())

const events: AuthenticatedRuntimeChannelEvents = {
  onTransportOpen: () => {},
  onAuthenticating: () => {},
  onAuthenticated: () => {},
  onText: () => {},
  onBinary: () => {},
  onAnswer: () => {},
  onClosed: () => {}
}

it('decides one link on every dial, so turning it on applies without a restart', () => {
  vi.stubEnv('ORCA_TEST_REMOTE_RUNTIME_ONE_LINK', '')
  const connection: PairedRuntimeConnection = {
    endpoint: runtimeRelayEndpoint({
      v: 1,
      directorUrl: 'https://relay.test',
      cellUrl: 'https://cell.test',
      assignmentEpoch: 1,
      relayHostId: 'H'.repeat(16),
      e2eeFraming: 2,
      inviteToken: 'I'.repeat(43),
      inviteExpiresAt: 4_102_444_800_000
    }),
    hostPublicKeyB64: btoa('k'.repeat(32)),
    pairedDeviceId: 'device-1',
    credential: { kind: 'token', deviceToken: 'device-token' }
  }
  const options = controlLinkOptions('env-relay', connection)
  // A Relay host's link is all it has: it always carries channels.
  expect(options.binaryChannels).toBe(true)
  const open = options.openChannel!([])
  const off = open(events)
  expect(off).toMatchObject({ ok: false, error: { code: 'relay_one_link_off' } })

  vi.stubEnv('ORCA_TEST_REMOTE_RUNTIME_ONE_LINK', '1')
  const on = open(events)
  expect(on.ok).toBe(true)
  if (on.ok) {
    on.channel.close()
  }
})
