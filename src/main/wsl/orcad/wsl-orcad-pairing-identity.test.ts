import { describe, expect, it } from 'vitest'
import {
  PAIRING_OFFER_VERSION,
  type PairingOffer
} from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { ServeReadiness } from '../../server/serve-readiness'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { OrcadManagedIdentityError } from '../../managed-server/lifecycle/orcad-managed-tunnel-identity'
import type { WslOrcadLaunch } from './wsl-orcad-launch-contract'
import { resolveWslOrcadPairing } from './wsl-orcad-pairing-identity'
import { recoverWslOrcad } from './wsl-orcad-liveness-recovery'
import { WslOrcadReconnectBackoff } from './wsl-orcad-reconnect-backoff'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'

const readiness: ServeReadiness = {
  runtimeId: 'runtime-new',
  boundEndpoint: null,
  advertisedEndpoint: null,
  managedWslCliReconciliation: 'settled',
  pairing: { available: false, reason: 'disabled_by_operator', guidance: 'enrolled clients only' }
}

const launch: Extract<WslOrcadLaunch, { outcome: 'ready' }> = {
  outcome: 'ready',
  distro: 'Ubuntu',
  distroId: null,
  linuxUser: 'qauser',
  defaultLinuxUser: null,
  port: 6800,
  fullVersion: '1.0.0',
  pid: 42,
  readiness,
  holder: 'spawned'
}

const paired: PairingOffer = {
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://127.0.0.1:6800',
  deviceToken: 'token',
  publicKeyB64: 'RRRR'
}

// An unclassified close: what a server with another key answers the pinned token with.
const foreign = async () => ({ verdict: 'foreign' as const, detail: 'socket closed (1006)' })

async function refusal(ready: typeof launch): Promise<unknown> {
  return resolveWslOrcadPairing(ready, 41000, paired, foreign).then(
    () => null,
    (error: unknown) => error
  )
}

// QA repro: a pinned host whose user's key was reset came back as an unsealed `foreign` refusal, so
// liveness retried for ~80 s and ended on the "another Orca may be using that port" text.
describe("a pinned WSL host's foreign answer after its key file changed", () => {
  it('is sealed with the WSL wording only when the key had already changed', async () => {
    const sealed = await refusal({ ...launch, pairedKeyChanged: true })
    expect(sealed).toBeInstanceOf(OrcadManagedIdentityError)
    expect(sealed).toMatchObject({ sealed: true })
    expect(sealed).toHaveProperty(
      'message',
      expect.stringMatching(/^(?!.*another Orca may be using).*Remove the WSL host and add it/s)
    )
    // Without the key fact it may be a restart: unsealed, so liveness still backs off.
    expect(await refusal(launch)).toMatchObject({ sealed: false })
    // A server whose own startup offer names the paired key was not reset, whatever the file says.
    const servesPaired = {
      ...readiness,
      pairing: {
        available: true as const,
        url: encodePairingOffer(paired),
        endpoint: paired.endpoint,
        deviceId: 'device',
        webClientUrl: null,
        scope: 'runtime' as const,
        qr: null
      }
    }
    expect(
      await refusal({ ...launch, pairedKeyChanged: true, readiness: servesPaired })
    ).toMatchObject({ sealed: false })
  })

  it('reaches liveness recovery as failed, with no backoff retry', async () => {
    const sealed = await refusal({ ...launch, pairedKeyChanged: true })
    const published: WslOrcadConnectionStatus[] = []
    let ensures = 0
    const verdict = await recoverWslOrcad(
      {
        distro: 'Ubuntu',
        backoff: new WslOrcadReconnectBackoff(() => 0),
        now: () => 0,
        current: () => true,
        wait: async () => {},
        publish: (status) => void published.push(status),
        ensure: async () => {
          ensures += 1
          throw sealed
        },
        collectCensus: async () => {
          throw new Error('never ready')
        },
        arm: async () => {},
        readRunning: async () => ({ status: 'confirmed', distros: ['Ubuntu'] })
      },
      'orcad-exited'
    )
    expect(verdict).toBeNull()
    expect(ensures).toBe(1)
    expect(published.at(-1)).toMatchObject({ state: 'failed' })
  })
})
