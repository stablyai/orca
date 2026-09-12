import { describe, expect, it, vi } from 'vitest'
import {
  createEnvironmentFromPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { PAIRING_OFFER_VERSION } from '../../shared/pairing'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshConnection } from './ssh-connection'
import type { SshConnectionManager } from './ssh-connection-manager'
import type { SshConnectionStore } from './ssh-connection-store'
import type { SshPortForwardManager } from './ssh-port-forward'
import { OrcadManagedTunnelManager } from './orcad-managed-tunnel'

function createEnvironment(linkKind: 'orcadDeployment' | 'sshAccess'): KnownRuntimeEnvironment {
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
  const access = {
    sshTargetId: 'ssh-1',
    sshTargetGeneration: 7,
    localPort: 46_768,
    remotePort: 6_768
  }
  return linkKind === 'orcadDeployment'
    ? { ...paired, orcadDeployment: access }
    : {
        ...paired,
        sshAccess: {
          ...access,
          endpointId: paired.preferredEndpointId,
          previousPreferredEndpointId: paired.preferredEndpointId
        }
      }
}

function setup(overrides: Partial<SshTarget> = {}) {
  const target: SshTarget = {
    id: 'ssh-1',
    label: 'Managed server',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    generation: 7,
    owner: { type: 'orcad-runtime', environmentId: 'environment-1' },
    ...overrides
  }
  let transportGeneration = 3
  const connection = {
    getTransportGeneration: vi.fn(() => transportGeneration)
  } as unknown as SshConnection
  const connect = vi.fn().mockResolvedValue(connection)
  const reconnect = vi.fn().mockImplementation(async () => {
    transportGeneration += 1
  })
  const getConnection = vi.fn(() => connection)
  const getState = vi.fn(() => ({ status: 'connected' }))
  const probeTunnel = vi.fn().mockResolvedValue(true)
  const addForward = vi
    .fn()
    .mockImplementation(
      async (
        connectionId: string,
        _connection: SshConnection,
        localPort: number,
        _remoteHost: string,
        remotePort: number
      ) => ({
        id: `forward-${addForward.mock.calls.length}`,
        connectionId,
        localPort,
        remoteHost: '127.0.0.1',
        remotePort
      })
    )
  const removeForwardAndWait = vi.fn().mockResolvedValue(null)
  const forwardManager = {
    setCallbacks: vi.fn(),
    addForward,
    removeForwardAndWait,
    dispose: vi.fn()
  } as unknown as SshPortForwardManager
  const connectionManager = {
    connect,
    getConnection,
    getState,
    reconnect
  } as unknown as SshConnectionManager
  const manager = new OrcadManagedTunnelManager({
    getConnectionManager: () => connectionManager,
    getTargetStore: () => ({ getTarget: vi.fn(() => target) }) as unknown as SshConnectionStore,
    forwardManager,
    probeTunnel
  })
  return {
    addForward,
    connect,
    connection,
    getConnection,
    getState,
    manager,
    probeTunnel,
    reconnect,
    removeForwardAndWait,
    target,
    setTransportGeneration: (generation: number) => {
      transportGeneration = generation
    }
  }
}

describe('OrcadManagedTunnelManager initial binding', () => {
  it.each(['close', 'dispose', 'reconnect'] as const)(
    'removes a late initial forward after %s supersedes setup',
    async (action) => {
      const state = setup()
      state.addForward.mockImplementationOnce(async () => {
        if (action === 'close') {
          await state.manager.close('environment-1')
        }
        if (action === 'dispose') {
          state.manager.dispose()
        }
        if (action === 'reconnect') {
          state.setTransportGeneration(4)
        }
        return { id: 'late-initial-forward', localPort: 46_768, remotePort: 6_768 }
      })

      await expect(
        state.manager.start('environment-1', state.target, state.connection, 6_768)
      ).rejects.toThrow('superseded')

      expect(state.removeForwardAndWait).toHaveBeenCalledWith('late-initial-forward')
      await state.manager.close('environment-1')
      expect(state.removeForwardAndWait).toHaveBeenCalledTimes(1)
    }
  )

  it('does not open a forward when canceled while the prior forward is closing', async () => {
    const state = setup()
    await state.manager.ensure(createEnvironment('sshAccess'))
    state.removeForwardAndWait.mockImplementationOnce(async () => {
      await state.manager.close('environment-1')
    })

    await expect(
      state.manager.start('environment-1', state.target, state.connection, 6_768)
    ).rejects.toThrow('superseded')

    expect(state.addForward).toHaveBeenCalledTimes(1)
  })

  it('discards an older binding without closing the newer tunnel', async () => {
    const state = setup()
    let finishFirst!: () => void
    state.addForward.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = () => resolve({ id: 'old-forward', localPort: 46_768, remotePort: 6_768 })
        })
    )
    const first = state.manager.start('environment-1', state.target, state.connection, 6_768)
    const rejected = expect(first).rejects.toThrow('superseded')
    await vi.waitFor(() => expect(state.addForward).toHaveBeenCalledOnce())

    await state.manager.start('environment-1', state.target, state.connection, 6_768)
    finishFirst()
    await rejected

    expect(state.removeForwardAndWait.mock.calls).toEqual([['old-forward']])
    await state.manager.close('environment-1')
    expect(state.removeForwardAndWait.mock.calls).toEqual([['old-forward'], ['forward-2']])
  })
})

describe.each(['orcadDeployment', 'sshAccess'] as const)(
  'OrcadManagedTunnelManager (%s)',
  (linkKind) => {
    const environment = () => createEnvironment(linkKind)
    const resumeOptions = () => ({
      attempts: 2,
      resolveEnvironment: () => environment(),
      timeoutMs: 5_000
    })
    it('connects through the raw SSH manager and creates the exact loopback forward', async () => {
      const state = setup()

      await state.manager.ensure(environment())

      expect(state.connect).toHaveBeenCalledOnce()
      if (linkKind === 'sshAccess') {
        expect(environment().orcadDeployment).toBeUndefined()
      }
      expect(state.addForward).toHaveBeenCalledWith(
        'ssh-1',
        expect.anything(),
        46_768,
        '127.0.0.1',
        6_768,
        'Managed Orca server: Managed server'
      )
    })

    it('reuses a tunnel only for the same SSH transport generation', async () => {
      const state = setup()

      await state.manager.ensure(environment())
      await state.manager.ensure(environment())
      expect(state.addForward).toHaveBeenCalledOnce()

      state.setTransportGeneration(4)
      await state.manager.ensure(environment())

      expect(state.removeForwardAndWait).toHaveBeenCalledWith('forward-1')
      expect(state.addForward).toHaveBeenCalledTimes(2)
    })

    it.each(['ensure', 'resume'] as const)(
      'discards a forward when SSH reconnects during %s binding',
      async (operation) => {
        const state = setup()
        if (operation === 'resume') {
          await state.manager.ensure(environment())
          state.probeTunnel.mockResolvedValue(false)
        }
        state.addForward.mockImplementationOnce(async () => {
          state.setTransportGeneration(9)
          return { id: 'stale-forward', localPort: 46_768, remotePort: 6_768 }
        })
        await (operation === 'resume'
          ? state.manager.recoverAfterHostResume(resumeOptions())
          : state.manager.ensure(environment()))
        expect(state.removeForwardAndWait).toHaveBeenCalledWith('stale-forward')
        state.probeTunnel.mockClear()
        await state.manager.recoverAfterHostResume(resumeOptions())
        expect(state.probeTunnel).not.toHaveBeenCalled()
        await state.manager.ensure(environment())
        expect(state.addForward).toHaveBeenCalledTimes(operation === 'resume' ? 3 : 2)
      }
    )

    it('fails closed when the SSH registration generation changed', async () => {
      const state = setup({ generation: 8 })

      await expect(state.manager.ensure(environment())).rejects.toThrow('removed or re-created')
      expect(state.connect).not.toHaveBeenCalled()
    })

    it('fails closed when another environment owns the target', async () => {
      const state = setup({ owner: { type: 'orcad-runtime', environmentId: 'environment-2' } })

      await expect(state.manager.ensure(environment())).rejects.toThrow('no longer owned')
      expect(state.connect).not.toHaveBeenCalled()
    })

    it('coalesces concurrent tunnel preflights', async () => {
      const state = setup()
      let finishConnect!: () => void
      state.connect.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishConnect = () => resolve(state.connection)
          })
      )

      const first = state.manager.ensure(environment())
      const second = state.manager.ensure(environment())
      finishConnect()
      await Promise.all([first, second])

      expect(state.connect).toHaveBeenCalledOnce()
      expect(state.addForward).toHaveBeenCalledOnce()
    })

    it('does not create a forward after close cancels an in-flight connection', async () => {
      const state = setup()
      state.connect.mockImplementationOnce(async () => {
        await state.manager.close('environment-1')
        return state.connection
      })

      await state.manager.ensure(environment())

      expect(state.addForward).not.toHaveBeenCalled()
    })

    it('rechecks SSH ownership after connection resolves', async () => {
      const state = setup()
      state.connect.mockImplementationOnce(async () => {
        state.target.owner = { type: 'orcad-runtime', environmentId: 'environment-2' }
        return state.connection
      })

      await state.manager.ensure(environment())

      expect(state.addForward).not.toHaveBeenCalled()
    })

    it('re-reads the saved environment after connection rather than trusting its initial snapshot', async () => {
      const state = setup()
      const original = environment()
      let current = original
      state.connect.mockImplementationOnce(async () => {
        current = {
          ...original,
          pairingRevision: (original.pairingRevision ?? original.createdAt) + 1
        }
        return state.connection
      })

      await state.manager.ensure(original, () => current)

      expect(state.addForward).not.toHaveBeenCalled()
    })

    it('removes a newly bound forward if the saved environment disappears during binding', async () => {
      const state = setup()
      const original = environment()
      let current: KnownRuntimeEnvironment | null = original
      state.addForward.mockImplementationOnce(async () => {
        current = null
        return { id: 'late-forward', localPort: 46_768, remotePort: 6_768 }
      })

      await state.manager.ensure(original, () => current)

      expect(state.removeForwardAndWait).toHaveBeenCalledWith('late-forward')
    })

    it('removes a newly bound forward if the environment closes during binding', async () => {
      const state = setup()
      state.addForward.mockImplementationOnce(async () => {
        await state.manager.close('environment-1')
        return { id: 'late-forward', localPort: 46_768, remotePort: 6_768 }
      })

      await state.manager.ensure(environment())

      expect(state.removeForwardAndWait).toHaveBeenCalledWith('late-forward')
      await state.manager.recoverAfterHostResume(resumeOptions())
      expect(state.probeTunnel).not.toHaveBeenCalled()
    })

    it('keeps a healthy managed tunnel intact after host resume', async () => {
      const state = setup()
      await state.manager.ensure(environment())

      await state.manager.recoverAfterHostResume(resumeOptions())

      expect(state.probeTunnel).toHaveBeenCalledOnce()
      expect(state.probeTunnel).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'environment-1' }),
        5_000
      )
      expect(state.reconnect).not.toHaveBeenCalled()
      expect(state.removeForwardAndWait).not.toHaveBeenCalled()
    })

    it('retries a failed wake probe before reconnecting', async () => {
      const state = setup()
      state.probeTunnel.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      await state.manager.ensure(environment())

      await state.manager.recoverAfterHostResume(resumeOptions())

      expect(state.probeTunnel).toHaveBeenCalledTimes(2)
      expect(state.reconnect).not.toHaveBeenCalled()
    })

    it('reconnects and rebuilds the exact persisted port after failed wake probes', async () => {
      const state = setup()
      state.probeTunnel.mockResolvedValue(false)
      await state.manager.ensure(environment())

      await state.manager.recoverAfterHostResume(resumeOptions())

      expect(state.reconnect).toHaveBeenCalledOnce()
      expect(state.reconnect).toHaveBeenCalledWith('ssh-1')
      expect(state.removeForwardAndWait).toHaveBeenCalledWith('forward-1')
      expect(state.addForward).toHaveBeenLastCalledWith(
        'ssh-1',
        state.connection,
        46_768,
        '127.0.0.1',
        6_768,
        'Managed Orca server: Managed server'
      )

      await state.manager.ensure(environment())
      expect(state.addForward).toHaveBeenCalledTimes(2)
    })

    it('coalesces concurrent host-resume recoveries', async () => {
      const state = setup()
      let finishProbe!: () => void
      state.probeTunnel.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishProbe = () => resolve(true)
          })
      )
      await state.manager.ensure(environment())

      const first = state.manager.recoverAfterHostResume(resumeOptions())
      const second = state.manager.recoverAfterHostResume(resumeOptions())
      expect(second).toBe(first)
      finishProbe()
      await Promise.all([first, second])

      expect(state.probeTunnel).toHaveBeenCalledOnce()
    })

    it('does not reconnect an environment closed during its wake probe', async () => {
      const state = setup()
      let finishProbe!: () => void
      state.probeTunnel.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishProbe = () => resolve(false)
          })
      )
      await state.manager.ensure(environment())

      const recovery = state.manager.recoverAfterHostResume({
        ...resumeOptions(),
        attempts: 1
      })
      await vi.waitFor(() => expect(state.probeTunnel).toHaveBeenCalledOnce())
      await state.manager.close('environment-1')
      finishProbe()
      await recovery

      expect(state.reconnect).not.toHaveBeenCalled()
      expect(state.addForward).toHaveBeenCalledOnce()
    })

    it('does not rebuild when reconnect did not establish a newer transport', async () => {
      const state = setup()
      state.probeTunnel.mockResolvedValue(false)
      state.reconnect.mockImplementationOnce(async () => undefined)
      await state.manager.ensure(environment())

      await state.manager.recoverAfterHostResume({
        ...resumeOptions(),
        attempts: 1
      })

      expect(state.reconnect).toHaveBeenCalledOnce()
      expect(state.removeForwardAndWait).not.toHaveBeenCalled()
      expect(state.addForward).toHaveBeenCalledOnce()
    })

    it('does not rebuild after re-pairing removes SSH access during reconnect', async () => {
      const state = setup()
      let current = environment()
      state.probeTunnel.mockResolvedValue(false)
      await state.manager.ensure(current)
      state.reconnect.mockImplementationOnce(async () => {
        state.setTransportGeneration(4)
        current = { ...current, orcadDeployment: undefined, sshAccess: undefined }
      })

      await state.manager.recoverAfterHostResume({
        ...resumeOptions(),
        resolveEnvironment: () => current
      })

      expect(state.addForward).toHaveBeenCalledOnce()
      expect(state.removeForwardAndWait).not.toHaveBeenCalled()
    })

    it('removes the replacement forward when re-pairing happens during resume binding', async () => {
      const state = setup()
      let current = environment()
      state.probeTunnel.mockResolvedValue(false)
      await state.manager.ensure(current)
      state.addForward.mockImplementationOnce(async () => {
        current = { ...current, orcadDeployment: undefined, sshAccess: undefined }
        return { id: 'late-forward', localPort: 46_768, remotePort: 6_768 }
      })

      await state.manager.recoverAfterHostResume({
        ...resumeOptions(),
        resolveEnvironment: () => current
      })

      expect(state.removeForwardAndWait).toHaveBeenCalledWith('late-forward')
    })
  }
)
