import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../persistence'
import { SshConnectionStore } from './ssh-connection-store'
import {
  ManagedOrcadPairingRepairs,
  liveManagedOrcadPairingRepairDeps
} from '../../managed-server/lifecycle/orcad-managed-pairing-repair'
import { buildWithPairingRepair } from '../../managed-server/lifecycle/orcad-managed-tunnel-pairing-recovery'
import { OrcadManagedPairingRejectedError } from '../../managed-server/lifecycle/orcad-managed-tunnel-identity'
import * as registry from '../targets/ssh-target-registry'
import { OrcadManagedTunnelManager } from '../../managed-server/lifecycle/orcad-managed-tunnel-manager'
import { createEnvironmentFromPairingOffer } from '../../../shared/runtime-environments'
import { PAIRING_OFFER_VERSION } from '../../../shared/pairing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clientInstances,
  emitSshEvent,
  eventHandlers,
  ssh2Mock
} from '../__tests__/ssh-connection-test-client'
import {
  resetSshConnectionMocks,
  nextSshClientCreation,
  advanceToNextSshClient
} from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnectionManager } from './ssh-connection-manager'
import type { SshConnectionCallbacks } from './ssh-connection-callbacks'
import {
  recordSshCredentialDeclined,
  resetSshCredentialDeclinesForTests
} from '../ssh-credential-decline'

vi.mock('../ssh2-module-load', async () =>
  (await import('../__tests__/ssh-connection-test-client')).createSsh2LoaderModule()
)
vi.mock('../system-transport/system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('../system-transport/system-ssh-args', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshArgsMocks(await importOriginal())
)
vi.mock('../system-transport/system-ssh-command', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshCommandMocks(await importOriginal())
)
vi.mock('../system-transport/system-ssh-file-binary-transfer', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshFileBinaryTransferMocks(
    await importOriginal()
  )
)
vi.mock('../system-transport/system-ssh-file-transfer', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshFileTransferMocks(
    await importOriginal()
  )
)
vi.mock('../ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('../config/ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)
vi.mock('../config/ssh-g-config-resolution', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSshGConfigResolutionMocks(
    await importOriginal()
  )
)

const authFailure = (): Error => new Error('All configured authentication methods failed')

function lastConnectPassword(): unknown {
  const config = clientInstances.at(-1)?.lastConnectConfig
  return config && typeof config === 'object' && 'password' in config ? config.password : undefined
}

describe('SshConnectionManager on a password host', () => {
  const onCredentialRequest = vi.fn<NonNullable<SshConnectionCallbacks['onCredentialRequest']>>(
    async () => 'hunter2'
  )
  let manager: SshConnectionManager

  beforeEach(async () => {
    resetSshConnectionMocks()
    resetSshCredentialDeclinesForTests()
    vi.stubEnv('SSH_AUTH_SOCK', '')
    onCredentialRequest.mockClear()
    manager = new SshConnectionManager(createCallbacks({ onCredentialRequest }))
    // The first sign-in: no key or agent, so the host refuses until the user types the password.
    ssh2Mock.connectSequence = [authFailure(), 'ready']
    await manager.connect(createTarget())
    expect(onCredentialRequest).toHaveBeenCalledTimes(1)
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await manager.disconnectAll()
  })

  it('preserves submitted-password stop and busy-attempt errors', async () => {
    await manager.disconnect('target-1')
    onCredentialRequest.mockResolvedValueOnce('incorrect-fixture-password')
    const refused = authFailure()
    ssh2Mock.connectSequence = [authFailure(), refused]

    await expect(manager.connect(createTarget())).rejects.toBe(refused)

    expect(onCredentialRequest).toHaveBeenCalledTimes(2)
    expect(manager.hasCachedCredential(createTarget())).toBe(false)
    expect(manager.getConnection('target-1')).toBeUndefined()

    const answer = Promise.withResolvers<string | null>()
    onCredentialRequest.mockImplementationOnce(() => answer.promise)
    ssh2Mock.connectSequence = [authFailure()]
    const pending = manager.connect(createTarget())
    const pendingResult = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(onCredentialRequest).toHaveBeenCalledTimes(3))

    await expect(manager.connect(createTarget())).rejects.toThrow('already in progress')
    answer.resolve(null)
    await pendingResult
  })

  it('preserves default-started nested repair joins through real SSH stop/exhaustion and reused Error', async () => {
    await manager.disconnect('target-1')
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'orca-D2-repair-owner-'))
    const targets = [1, 2].map((i) =>
      createTarget({
        id: `target-${i}`,
        generation: 7,
        orcadFence: { environmentId: `repair-${i}` }
      })
    )
    const environments = targets.map((target, i) => ({
      ...createEnvironmentFromPairingOffer({
        id: `repair-${i + 1}`,
        name: 'Repair',
        now: 1,
        connectionDependency: 'ssh-tunnel',
        offer: {
          v: PAIRING_OFFER_VERSION,
          endpoint: 'ws://127.0.0.1:42000',
          deviceToken: 'fixture',
          publicKeyB64: 'fixture'
        }
      }),
      orcadDeployment: {
        sshTargetId: target.id,
        sshTargetGeneration: 7,
        localPort: 42000,
        remotePort: 6768
      }
    }))
    const targetStore = new SshConnectionStore(
      new Store({ dataFile: join(root, 'state.json'), serializedState: '{}' })
    )
    vi.spyOn(targetStore, 'getTarget').mockImplementation((id) =>
      targets.find((target) => target.id === id)
    )
    vi.spyOn(registry, 'getSshTargetRegistryStore').mockReturnValue(targetStore)
    vi.spyOn(registry, 'getSshConnectionManager').mockReturnValue(manager)
    const readReadiness = vi.fn(async () => null)
    const repairs = new ManagedOrcadPairingRepairs({
      ...liveManagedOrcadPairingRepairDeps(root),
      resolve: (id) => environments.find((environment) => environment.id === id)!,
      readReadiness
    })
    try {
      const reused: Error & { code?: string } = new Error('untyped external startup failure')
      const release = Promise.withResolvers<void>()
      const cleaned = Promise.withResolvers<void>()
      const originalClose = manager.disconnectConnection.bind(manager)
      vi.spyOn(manager, 'disconnectConnection').mockImplementationOnce(async (...args) => {
        await originalClose(...args)
        cleaned.resolve()
        await release.promise
      })
      ssh2Mock.connectSequence = [reused]

      const firstCreated = nextSshClientCreation()
      const first = repairs.repair('repair-1', 1)
      expect(repairs.repair('repair-1', 999)).toBe(first)
      const firstResult = expect(first).rejects.toBe(reused)
      await firstCreated
      await vi.advanceTimersByTimeAsync(1)
      await cleaned.promise
      const firstRecovery = buildWithPairingRepair(
        {
          resolve: () => environments[0],
          repairs,
          ensure: async () => {
            throw new Error('Repair must not reach ensure')
          }
        },
        'repair-1',
        async () => {
          throw new OrcadManagedPairingRejectedError('sealed refusal')
        }
      )
      const recoveredResult = expect(firstRecovery).rejects.toBe(reused)

      reused.code = 'ECONNREFUSED'
      ssh2Mock.connectSequence = Array.from({ length: 5 }, () => reused)

      const secondCreated = nextSshClientCreation()
      const second = repairs.repair('repair-2', 1)
      expect(repairs.repair('repair-2', 1)).toBe(second)
      const secondResult = expect(second).rejects.toBe(reused)
      await secondCreated
      await vi.advanceTimersByTimeAsync(1)
      for (let retry = 0; retry < 4; retry++) {
        await advanceToNextSshClient(2_000)
      }
      await secondResult

      release.resolve()
      await firstResult
      await recoveredResult

      expect(manager.getConnection('target-1')).toBeUndefined()
      expect(manager.getConnection('target-2')).toBeUndefined()
      delete reused.code
      ssh2Mock.connectSequence = [reused]

      const sequentialCreated = nextSshClientCreation()
      const sequential = repairs.repair('repair-1', 1)
      expect(sequential).not.toBe(first)
      expect(repairs.repair('repair-1', 1)).toBe(sequential)
      const sequentialResult = expect(sequential).rejects.toBe(reused)
      await sequentialCreated
      await vi.advanceTimersByTimeAsync(1)
      await sequentialResult

      expect(readReadiness).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('carries the default-started shared build through its existing single joined retry', async () => {
    await manager.disconnect('target-1')
    const root = mkdtempSync(join(tmpdir(), 'orca-D2-tunnel-owner-'))
    const target = createTarget({ generation: 7, orcadFence: { environmentId: 'environment-1' } })
    const targetStore = new SshConnectionStore(
      new Store({ dataFile: join(root, 'state.json'), serializedState: '{}' })
    )
    vi.spyOn(targetStore, 'getTarget').mockReturnValue(target)
    const tunnels = new OrcadManagedTunnelManager({
      getConnectionManager: () => manager,
      getTargetStore: () => targetStore
    })
    const environment = {
      ...createEnvironmentFromPairingOffer({
        id: 'environment-1',
        name: 'Builder',
        now: 1,
        connectionDependency: 'ssh-tunnel',
        offer: {
          v: PAIRING_OFFER_VERSION,
          endpoint: 'ws://127.0.0.1:42000',
          deviceToken: 'fixture',
          publicKeyB64: 'fixture'
        }
      }),
      orcadDeployment: {
        sshTargetId: target.id,
        sshTargetGeneration: 7,
        localPort: 42000,
        remotePort: 6768
      }
    }
    const firstFailure = new Error('first untyped owner stop')
    const finalFailure = new Error('final untyped owner stop')
    ssh2Mock.connectSequence = ['silent', 'silent']
    try {
      const firstCreated = nextSshClientCreation()
      const ordinary = tunnels.ensure(environment)
      const ordinaryResult = expect(ordinary).rejects.toBe(firstFailure)
      await firstCreated
      const firstClient = clientInstances.at(-1)!

      const joined = tunnels.ensure(environment, () => environment)
      const joinedResult = expect(joined).rejects.toBe(finalFailure)
      const replacementCreated = nextSshClientCreation()
      firstClient.emit('error', firstFailure)
      await ordinaryResult
      await replacementCreated

      clientInstances.at(-1)!.emit('error', finalFailure)
      await joinedResult

      expect(manager.getConnection(target.id)).toBeUndefined()
    } finally {
      await tunnels.shutdown()
      tunnels.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves primary and cleanup errors through actual startup cleanup failure', async () => {
    await manager.disconnect('target-1')
    const startup = new Error('untyped primary failure')
    const cleanup = new Error('cleanup failed')
    vi.spyOn(manager, 'disconnectConnection').mockRejectedValueOnce(cleanup)
    ssh2Mock.connectSequence = [startup]

    const result: unknown = await manager.connect(createTarget()).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(AggregateError)
    if (!(result instanceof AggregateError)) {
      throw new Error('Expected startup/cleanup aggregate')
    }
    expect(result.errors).toEqual([startup, cleanup])
    expect(result.message).toBe('ssh_connection_startup_cleanup_failed')
  })

  it('does not ask again when a background dial lands while the dropped connection reconnects', async () => {
    const dropped = manager.getConnection('target-1')
    emitSshEvent('close')
    expect(dropped?.getState().status).toBe('reconnecting')

    ssh2Mock.connectSequence = ['ready']
    const replacement = await manager.connect(createTarget())

    expect(replacement).not.toBe(dropped)
    expect(replacement.getState().status).toBe('connected')
    expect(lastConnectPassword()).toBe('hunter2')
    expect(onCredentialRequest).toHaveBeenCalledTimes(1)
  })

  it('does not ask again after a background owner closed the connection it opened', async () => {
    await manager.disconnectConnection('target-1', manager.getConnection('target-1')!)

    ssh2Mock.connectSequence = ['ready']
    await manager.connect(createTarget())

    expect(lastConnectPassword()).toBe('hunter2')
    expect(onCredentialRequest).toHaveBeenCalledTimes(1)
    expect(manager.hasCachedCredential(createTarget())).toBe(true)
  })

  it('keeps the sign-in across a replacement that failed for a reason other than sign-in', async () => {
    await manager.disconnectConnection('target-1', manager.getConnection('target-1')!)
    ssh2Mock.connectSequence = [new Error('Handshake failed: signature verification failed')]
    await expect(manager.connect(createTarget())).rejects.toThrow('signature verification failed')

    ssh2Mock.connectSequence = ['ready']
    await manager.connect(createTarget())

    expect(lastConnectPassword()).toBe('hunter2')
    expect(onCredentialRequest).toHaveBeenCalledTimes(1)
  })

  it('asks again, once, after the host refuses the remembered password', async () => {
    await manager.disconnectConnection('target-1', manager.getConnection('target-1')!)
    ssh2Mock.connectSequence = [authFailure()]
    await expect(manager.connect(createTarget())).rejects.toThrow('authentication methods failed')
    expect(onCredentialRequest).toHaveBeenCalledTimes(1)

    onCredentialRequest.mockResolvedValueOnce('new-password')
    ssh2Mock.connectSequence = [authFailure(), 'ready']
    await manager.connect(createTarget())

    expect(onCredentialRequest).toHaveBeenCalledTimes(2)
    expect(lastConnectPassword()).toBe('new-password')
  })

  it('drops a remembered password the host re-asked for while a reconnect was signing in', async () => {
    ssh2Mock.connectSequence = ['silent']
    void manager.reconnect('target-1')
    await vi.waitFor(() =>
      expect(eventHandlers.get('keyboard-interactive')?.size ?? 0).toBeGreaterThan(0)
    )
    const passwordPrompt = [{ prompt: 'Password: ', echo: false }]
    const autoAnswered = vi.fn()
    emitSshEvent('keyboard-interactive', '', '', '', passwordPrompt, autoAnswered)
    await vi.waitFor(() => expect(autoAnswered).toHaveBeenCalledWith(['hunter2']))
    // The server asks again, so the remembered password was refused; the user has not answered yet.
    onCredentialRequest.mockImplementationOnce(() => new Promise(() => {}))
    emitSshEvent('keyboard-interactive', '', '', '', passwordPrompt, vi.fn())
    await vi.waitFor(() => expect(onCredentialRequest).toHaveBeenCalledTimes(2))
    // A background dial may not close the dialog the user is answering.
    await expect(manager.connect(createTarget())).rejects.toThrow('already in progress')
    await manager.disconnectConnection('target-1', manager.getConnection('target-1')!)

    ssh2Mock.connectSequence = [authFailure(), 'ready']
    await manager.connect(createTarget())

    expect(onCredentialRequest).toHaveBeenCalledTimes(3)
  })

  it('does not hand on a typed password the host never accepted', async () => {
    await manager.disconnect('target-1')
    onCredentialRequest.mockResolvedValueOnce('typo')
    ssh2Mock.connectSequence = [
      authFailure(),
      new Error('Handshake failed: signature verification failed')
    ]
    await expect(manager.connect(createTarget())).rejects.toThrow('signature verification failed')
    expect(manager.hasCachedCredential(createTarget())).toBe(false)

    ssh2Mock.connectSequence = [authFailure(), 'ready']
    await manager.connect(createTarget())

    expect(onCredentialRequest).toHaveBeenCalledTimes(3)
  })

  it('keeps refusing background dials after the user cancelled a sign-in', async () => {
    await manager.disconnectConnection('target-1', manager.getConnection('target-1')!)
    recordSshCredentialDeclined('target-1')
    const clientsBefore = clientInstances.length

    await expect(manager.connect(createTarget())).rejects.toThrow('was cancelled')
    expect(clientInstances).toHaveLength(clientsBefore)
  })

  it('asks again when the host was edited to point somewhere else', async () => {
    await manager.disconnectConnection('target-1', manager.getConnection('target-1')!)
    const edited = createTarget({ host: 'other.example.com' })
    expect(manager.hasCachedCredential(edited)).toBe(false)

    ssh2Mock.connectSequence = [authFailure(), 'ready']
    await manager.connect(edited)

    expect(onCredentialRequest).toHaveBeenCalledTimes(2)
  })

  it('forgets the sign-in when the user disconnects', async () => {
    await manager.disconnect('target-1')
    expect(manager.hasCachedCredential(createTarget())).toBe(false)

    ssh2Mock.connectSequence = [authFailure(), 'ready']
    await manager.connect(createTarget())

    expect(onCredentialRequest).toHaveBeenCalledTimes(2)
  })
})
