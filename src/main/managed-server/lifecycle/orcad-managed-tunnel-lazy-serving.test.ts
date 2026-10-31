import { expect, it, vi } from 'vitest'
import { createEnvironmentFromPairingOffer } from '../../../shared/runtime-environments'
import { PAIRING_OFFER_VERSION } from '../../../shared/pairing'
import { SshConnection } from '../../ssh/connection/ssh-connection'
import type { OrcadManagedServingCheck } from './orcad-managed-tunnel-resume'
import type * as TunnelManagerModule from './orcad-managed-tunnel-manager'

const serving = vi.hoisted((): { check?: OrcadManagedServingCheck } => ({}))

vi.mock('./orcad-managed-tunnel-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof TunnelManagerModule>()
  return {
    OrcadManagedTunnelManager: class extends actual.OrcadManagedTunnelManager {
      constructor(...args: ConstructorParameters<typeof actual.OrcadManagedTunnelManager>) {
        super(...args)
        serving.check = args[0].ensureServing
      }
    }
  }
})

vi.mock('./orcad-managed-serving', () => {
  throw new Error('Managed serving implementation is unavailable')
})

it('imports and shuts down unused tunnels without loading managed serving', async () => {
  const { shutdownOrcadManagedTunnels } = await import('./orcad-managed-tunnel')
  await import('../../ssh/managed-server-serving-gate')
  await import('../../ipc/runtime-environments/runtime-environment-managed-tunnel')

  await expect(shutdownOrcadManagedTunnels()).resolves.toBeUndefined()
})

it('reports an unavailable serving implementation when managed serving is requested', async () => {
  await import('./orcad-managed-tunnel')
  const check = serving.check
  expect(check).toBeTypeOf('function')
  if (!check) {
    throw new Error('Managed tunnel did not register its serving operation')
  }
  const target = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }
  const environment = createEnvironmentFromPairingOffer({
    id: 'env-1',
    name: 'Box',
    now: 1,
    connectionDependency: 'ssh-tunnel',
    offer: {
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'device-token',
      publicKeyB64: 'public-key'
    }
  })
  const operation = check({
    environment,
    target,
    connection: new SshConnection(target, { onStateChange: () => {} }),
    remotePort: 6768
  })

  await expect(operation).rejects.toMatchObject({
    cause: { message: 'Managed serving implementation is unavailable' }
  })
})
