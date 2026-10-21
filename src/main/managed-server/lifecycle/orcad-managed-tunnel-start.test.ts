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
import type { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import { SshTargetStartWindow } from '../../ssh/ssh-target-start-window'
import { OrcadManagedTunnelManager } from './orcad-managed-tunnel-manager'
import { ensureTunnelAfterHostStart } from './orcad-managed-tunnel-start'
import { supersededTunnelError } from './orcad-managed-tunnel-active'

const FORWARD_RESET = 'System SSH port forward failed (exit 255): Connection reset by 127.0.0.1'

function environment(): KnownRuntimeEnvironment {
  const paired = createEnvironmentFromPairingOffer({
    id: 'environment-1',
    name: 'Machine server',
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
      sshTargetId: 'machine-1',
      sshTargetGeneration: 7,
      localPort: 46_768,
      remotePort: 6_768
    }
  }
}

function setup() {
  const target: SshTarget = {
    id: 'machine-1',
    label: 'Machine',
    host: '127.0.0.1',
    port: 42_290,
    username: 'dev',
    generation: 7,
    orcadFence: { environmentId: 'environment-1' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the members the tunnel manager calls.
  const connection = { getConnectGeneration: vi.fn(() => 1) } as unknown as SshConnection
  const addForward = vi.fn(
    async (
      connectionId: string,
      _c: SshConnection,
      localPort: number,
      _h: string,
      port: number
    ) => ({
      id: `forward-${addForward.mock.calls.length}`,
      connectionId,
      localPort,
      remoteHost: '127.0.0.1',
      remotePort: port
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the members the tunnel manager calls.
  const forwardManager = {
    setCallbacks: vi.fn(),
    addForward,
    removeForwardAndWait: vi.fn().mockResolvedValue(null),
    closeAll: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn()
  } as unknown as SshPortForwardManager
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the members the tunnel manager calls.
  const connectionManager = {
    connect: vi.fn().mockResolvedValue(connection),
    getConnection: vi.fn(() => connection),
    getState: vi.fn(() => ({ status: 'connected' }))
  } as unknown as SshConnectionManager
  const delay = vi.fn(async (_ms: number) => undefined)
  const starts = new SshTargetStartWindow({ now: Date.now, delay })
  const manager = new OrcadManagedTunnelManager({
    getConnectionManager: () => connectionManager,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tunnel manager reads only getTarget.
    getTargetStore: () => ({ getTarget: vi.fn(() => target) }) as unknown as SshConnectionStore,
    forwardManager,
    probeTunnel: vi.fn().mockResolvedValue(true),
    ensureServing: vi.fn().mockResolvedValue({ state: 'serving' })
  })
  const ensure = () => ensureTunnelAfterHostStart(manager, environment(), undefined, starts)
  return { addForward, delay, ensure, starts }
}

describe('ensureTunnelAfterHostStart', () => {
  it('waits for a wake in flight before forwarding to the machine', async () => {
    const { addForward, ensure, starts } = setup()
    let finishWake: () => void = () => undefined
    starts.noteStarting(
      'machine-1',
      new Promise<void>((resolve) => {
        finishWake = resolve
      })
    )
    const ensured = ensure()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(addForward).not.toHaveBeenCalled()
    starts.noteStarted('machine-1')
    finishWake()
    await expect(ensured).resolves.toBeUndefined()
    expect(addForward).toHaveBeenCalledTimes(1)
  })

  it('redials the forward while a just-woken machine starts sshd', async () => {
    const { addForward, delay, ensure, starts } = setup()
    starts.noteStarted('machine-1')
    addForward.mockRejectedValueOnce(new Error(FORWARD_RESET))
    await expect(ensure()).resolves.toBeUndefined()
    expect(delay).toHaveBeenCalledWith(2_000)
    expect(addForward).toHaveBeenCalledTimes(2)
  })

  it('never redials past a refused host key', async () => {
    const { addForward, delay, ensure, starts } = setup()
    starts.noteStarted('machine-1')
    addForward.mockRejectedValueOnce(
      new Error('System SSH port forward failed (exit 255): Host key verification failed.')
    )
    await expect(ensure()).rejects.toThrow('Host key verification failed')
    expect(delay).not.toHaveBeenCalled()
  })

  it('fails at once outside the start window, as before', async () => {
    const { addForward, delay, ensure } = setup()
    addForward.mockRejectedValueOnce(new Error(FORWARD_RESET))
    await expect(ensure()).rejects.toThrow('Connection reset')
    expect(delay).not.toHaveBeenCalled()
  })

  it('never rebuilds a tunnel that a close superseded', async () => {
    const { delay, starts } = setup()
    starts.noteStarted('machine-1')
    const tunnels = { ensure: vi.fn().mockRejectedValue(supersededTunnelError()) }
    await expect(
      ensureTunnelAfterHostStart(tunnels, environment(), undefined, starts)
    ).rejects.toThrow()
    expect(tunnels.ensure).toHaveBeenCalledTimes(1)
    expect(delay).not.toHaveBeenCalled()
  })
})
