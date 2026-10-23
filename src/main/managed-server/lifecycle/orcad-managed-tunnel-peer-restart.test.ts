import { describe, expect, it, vi } from 'vitest'
import {
  createEnvironmentFromPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { PAIRING_OFFER_VERSION } from '../../../shared/pairing'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import type { SshConnectionStore } from '../../ssh/connection/ssh-connection-store'
import { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider
} from '../../ssh/port-forwarding/ssh-port-forward-provider'
import { OrcadManagedTunnelManager } from './orcad-managed-tunnel-manager'
import type { OrcadManagedServing } from './orcad-managed-serving'

function createEnvironment(): KnownRuntimeEnvironment {
  const paired = createEnvironmentFromPairingOffer({
    id: 'environment-1',
    name: 'Managed server',
    now: 1,
    offer: {
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://127.0.0.1:46768',
      deviceToken: 'device-token',
      publicKeyB64: 'public-key'
    },
    connectionDependency: 'ssh-tunnel'
  })
  return {
    ...paired,
    orcadDeployment: {
      sshTargetId: 'ssh-1',
      sshTargetGeneration: 7,
      localPort: 46_768,
      remotePort: 6_768
    }
  }
}

/** One host whose server another desktop can restart onto a new port behind this one's back. */
function setup(options: { publishesPort?: boolean } = {}) {
  const host = { boundPort: 6_768 }
  const target: SshTarget = {
    id: 'ssh-1',
    label: 'Managed server',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    generation: 7,
    orcadFence: { environmentId: 'environment-1' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the members the tunnel manager calls.
  const connection = {
    getConnectGeneration: () => 3,
    isDisposed: () => false
  } as unknown as SshConnection
  const forwardedTo = new Map<string, number>()
  const provider: SshPortForwardProvider = {
    canHandle: () => true,
    start: async (_conn: SshConnection, start: PortForwardStartOptions) => {
      forwardedTo.set(start.id, start.remotePort)
      return {
        entry: {
          id: start.id,
          connectionId: start.connectionId,
          localPort: start.localPort,
          remoteHost: start.remoteHost,
          remotePort: start.remotePort
        },
        close: async () => {
          forwardedTo.delete(start.id)
        },
        dispose: () => {
          forwardedTo.delete(start.id)
        }
      }
    }
  }
  // A live server that does not answer on the forwarded port: the wake's "live but not answering".
  const ensureServing = vi.fn(
    async ({ remotePort }: { remotePort: number }): Promise<OrcadManagedServing> =>
      remotePort === host.boundPort
        ? { state: 'serving' }
        : {
            state: 'unverifiable',
            detail: 'The managed Orca server process is live but is not answering.'
          }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the members the tunnel manager calls.
  const connectionManager = {
    connect: vi.fn(async () => connection)
  } as unknown as SshConnectionManager
  const manager = new OrcadManagedTunnelManager({
    getConnectionManager: () => connectionManager,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tunnel manager reads only getTarget.
    getTargetStore: () => ({ getTarget: () => target }) as unknown as SshConnectionStore,
    forwardManager: new SshPortForwardManager({}, [provider]),
    targeting: {
      resolveRemotePort: async () => host.boundPort,
      verifyIdentity: async () => ({ verdict: 'verified' }),
      readPublishedPort: async () => (options.publishesPort === false ? null : host.boundPort)
    },
    ensureServing
  })
  return { ensureServing, forwardedTo, host, manager }
}

describe("a managed tunnel follows another desktop's restart of the server", () => {
  it("rebinds to the port the host's readiness names, and the server answers again", async () => {
    const state = setup()
    const environment = createEnvironment()
    await state.manager.ensure(environment)
    expect([...state.forwardedTo.values()]).toEqual([6_768])

    // Another desktop updated the host; its server came back on a different port.
    state.host.boundPort = 7_001

    await expect(state.manager.verifyServing(environment)).resolves.toEqual({ state: 'serving' })
    expect([...state.forwardedTo.values()]).toEqual([7_001])
  })

  it('keeps the tunnel when the host names no port (an older server), reporting unverifiable', async () => {
    const state = setup({ publishesPort: false })
    const environment = createEnvironment()
    await state.manager.ensure(environment)
    state.host.boundPort = 7_001

    await expect(state.manager.verifyServing(environment)).resolves.toMatchObject({
      state: 'unverifiable'
    })
    expect([...state.forwardedTo.values()]).toEqual([6_768])
  })

  it('keeps the tunnel when the host still names the forwarded port', async () => {
    const state = setup()
    const environment = createEnvironment()
    await state.manager.ensure(environment)
    state.ensureServing.mockResolvedValueOnce({ state: 'unverifiable', detail: 'not answering' })

    await expect(state.manager.verifyServing(environment)).resolves.toMatchObject({
      state: 'unverifiable'
    })
    expect([...state.forwardedTo.values()]).toEqual([6_768])
  })
})
