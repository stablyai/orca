import { describe, expect, it, vi } from 'vitest'
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { PAIRING_OFFER_VERSION } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import {
  environmentForwardChecks,
  forwardToVerifiedOrcad,
  type OrcadManagedTunnelTargeting
} from './orcad-managed-tunnel-target'
import {
  OrcadManagedIdentityError,
  type OrcadTunnelIdentity
} from './orcad-managed-tunnel-identity'

// A client newer than the host can fail the E2EE handshake on shape, not on identity (#43180).
const SKEWED_HANDSHAKE_DETAIL = 'Remote Orca runtime returned an unexpected E2EE handshake frame.'

function createEnvironment(publicKeyB64: string): KnownRuntimeEnvironment {
  return createEnvironmentFromPairingOffer({
    id: 'environment-1',
    name: 'Managed server',
    now: 1,
    offer: {
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://127.0.0.1:46768',
      deviceToken: 'device-token',
      publicKeyB64
    },
    connectionDependency: 'ssh-tunnel'
  })
}

function targeting(options: {
  identity: OrcadTunnelIdentity
  publishedKey: string | null
}): OrcadManagedTunnelTargeting {
  return {
    resolveRemotePort: async () => 6768,
    verifyIdentity: async () => options.identity,
    readPublishedKey: async () => options.publishedKey
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the two members forwardToVerifiedOrcad calls.
const forwards = {
  addForward: async () => ({
    id: 'forward-1',
    connectionId: 'c1',
    localPort: 46768,
    remoteHost: '127.0.0.1',
    remotePort: 6768
  }),
  removeForwardAndWait: async () => undefined
} as unknown as SshPortForwardManager
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the member the forward checks read.
const connection = { getConnectGeneration: () => 3 } as unknown as SshConnection

async function verify(identity: OrcadTunnelIdentity, publishedKey: string | null) {
  const environment = createEnvironment('pinned-key')
  const checks = await environmentForwardChecks(targeting({ identity, publishedKey }), {
    environment,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the target id is read here.
    target: { id: 'ssh-1' } as never,
    connection
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    const forward = await forwardToVerifiedOrcad({
      targetId: 'ssh-1',
      connection,
      forwards,
      localPort: 0,
      label: 'test',
      remotePort: 6768,
      rereadRemotePort: checks.rereadRemotePort,
      verify: checks.verify,
      stillCurrent: () => true
    })
    return { verdict: 'forwarded' as const, forward }
  } catch (error) {
    return { verdict: 'error' as const, error }
  } finally {
    warn.mockRestore()
  }
}

describe('managed tunnel identity verdicts against an older host', () => {
  it('keeps the tunnel and sessions when the slot still publishes the pinned key', async () => {
    const result = await verify(
      { verdict: 'foreign', detail: SKEWED_HANDSHAKE_DETAIL },
      getPreferredPairingOffer(createEnvironment('pinned-key')).publicKeyB64
    )
    expect(result.verdict).toBe('forwarded')
  })

  it('still reports a replaced server when the slot publishes a different key', async () => {
    const result = await verify(
      { verdict: 'foreign', detail: SKEWED_HANDSHAKE_DETAIL },
      'another-key'
    )
    expect(result.verdict).toBe('error')
    expect(result.verdict === 'error' && result.error).toBeInstanceOf(OrcadManagedIdentityError)
  })

  it('still reports a foreign port when the slot publishes no key', async () => {
    const result = await verify({ verdict: 'foreign', detail: SKEWED_HANDSHAKE_DETAIL }, null)
    expect(result.verdict).toBe('error')
    expect(result.verdict === 'error' && result.error).toBeInstanceOf(OrcadManagedIdentityError)
  })
})
