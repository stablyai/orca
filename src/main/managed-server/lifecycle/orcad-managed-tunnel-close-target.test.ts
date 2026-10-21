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
import {
  PERSISTED_PORT_TARGETING,
  type OrcadManagedTunnelTargeting
} from './orcad-managed-tunnel-target'
import type { OrcadTunnelIdentity } from './orcad-managed-tunnel-identity'

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

/** A real forward manager over a provider whose forwards stay "listening" until closed. */
function setup(
  options: { targeting?: OrcadManagedTunnelTargeting; startGate?: Promise<void> } = {}
) {
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
  const listening = new Set<string>()
  const provider: SshPortForwardProvider = {
    canHandle: () => true,
    start: async (_conn: SshConnection, start: PortForwardStartOptions) => {
      listening.add(start.id)
      await options.startGate
      const entry = {
        id: start.id,
        connectionId: start.connectionId,
        localPort: start.localPort,
        remoteHost: start.remoteHost,
        remotePort: start.remotePort
      }
      return {
        entry,
        close: async () => {
          listening.delete(start.id)
        },
        dispose: () => {
          listening.delete(start.id)
        }
      }
    }
  }
  const connect = vi.fn().mockResolvedValue(connection)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the members the tunnel manager calls.
  const connectionManager = { connect } as unknown as SshConnectionManager
  const manager = new OrcadManagedTunnelManager({
    getConnectionManager: () => connectionManager,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tunnel manager reads only getTarget.
    getTargetStore: () => ({ getTarget: () => target }) as unknown as SshConnectionStore,
    forwardManager: new SshPortForwardManager({}, [provider]),
    targeting: options.targeting
  })
  return { connect, connection, listening, manager }
}

describe('OrcadManagedTunnelManager.closeTarget (the SSH session teardown)', () => {
  it("closes the host's built tunnel, so nothing keeps listening after Disconnect", async () => {
    const state = setup()
    const environment = createEnvironment()
    await state.manager.ensure(environment)
    expect(state.listening.size).toBe(1)

    await state.manager.closeTarget('ssh-1')

    expect(state.listening.size).toBe(0)
  })

  it('leaves the tunnels of other hosts alone', async () => {
    const state = setup()
    await state.manager.ensure(createEnvironment())

    await state.manager.closeTarget('ssh-2')

    expect(state.listening.size).toBe(1)
  })

  it('supersedes a build still dialling, so it opens no forward after the teardown', async () => {
    const state = setup()
    let finishConnect: (connection: SshConnection) => void = () => {}
    state.connect.mockReturnValueOnce(
      new Promise<SshConnection>((resolve) => {
        finishConnect = resolve
      })
    )
    const build = state.manager.ensure(createEnvironment(), undefined, false)
    await vi.waitFor(() => expect(state.connect).toHaveBeenCalled())

    await state.manager.closeTarget('ssh-1')
    finishConnect(state.connection)

    await expect(build).rejects.toThrow('superseded')
    expect(state.listening.size).toBe(0)
  })

  it('closes a forward whose identity check is still running before it resolves', async () => {
    let answer: (identity: OrcadTunnelIdentity) => void = () => {}
    const verifyIdentity = vi.fn(
      () =>
        new Promise<OrcadTunnelIdentity>((resolve) => {
          answer = resolve
        })
    )
    const state = setup({ targeting: { ...PERSISTED_PORT_TARGETING, verifyIdentity } })
    const build = state.manager.ensure(createEnvironment(), undefined, false)
    await vi.waitFor(() => expect(verifyIdentity).toHaveBeenCalled())
    expect(state.listening.size).toBe(1)

    await state.manager.closeTarget('ssh-1')

    expect(state.listening.size).toBe(0)
    answer({ verdict: 'verified' })
    await expect(build).rejects.toThrow('superseded')
    expect(state.listening.size).toBe(0)
  })

  it('waits out a forward still starting and closes it before it resolves', async () => {
    let release: () => void = () => {}
    const startGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const state = setup({ startGate })
    const build = state.manager.ensure(createEnvironment(), undefined, false)
    await vi.waitFor(() => expect(state.listening.size).toBe(1))

    let closed = false
    const teardown = state.manager.closeTarget('ssh-1').then(() => {
      closed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closed).toBe(false)
    release()
    await teardown

    expect(state.listening.size).toBe(0)
    await expect(build).rejects.toThrow()
  })
})
