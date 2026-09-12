import { describe, expect, it, vi } from 'vitest'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import {
  mocks,
  operationOrder,
  target,
  claimedTarget,
  migrationManifest,
  sourceCutover,
  migrationStore,
  originalStopAuthority,
  managedEnvironment,
  targetStore,
  readiness,
  environment,
  createManagedOrcadEnvironment,
  getManagedOrcadRuntimeStatus,
  listPendingManagedOrcadMigrations,
  recoverManagedOrcadEnvironment,
  updateManagedOrcadEnvironment,
  rollbackManagedOrcadEnvironment,
  stopManagedOrcadEnvironment
} from './orcad-runtime-lifecycle-fixture'

describe('createManagedOrcadEnvironment', () => {
  it('durably fences the SSH target before the first remote deployment boundary', async () => {
    const result = await createManagedOrcadEnvironment('/user-data', {
      name: 'Managed server',
      sshTargetId: 'ssh-1'
    })

    expect(operationOrder.slice(0, 5)).toEqual([
      'assert',
      'begin',
      'ensure-generation',
      'flush-generation',
      'connect'
    ])
    expect(mocks.beginCutover).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationEnvironmentId: 'environment-1',
        destinationName: 'Managed server',
        manifest: migrationManifest
      })
    )
    expect(mocks.connect).toHaveBeenCalledWith(claimedTarget)
    expect(mocks.addEnvironment).toHaveBeenCalledWith(
      '/user-data',
      expect.objectContaining({
        id: 'environment-1',
        orcadDeployment: expect.objectContaining({ sshTargetGeneration: 7 })
      })
    )
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
    expect(mocks.commitDestination).toHaveBeenCalledWith(
      expect.objectContaining({ migrationId: 'migration-1', pairingCode: 'orca://pair?managed' })
    )
    expect(mocks.retireSource).toHaveBeenCalledWith(
      expect.objectContaining({ migrationId: 'migration-1' })
    )
    expect(result).toMatchObject({ outcome: 'created', environment })
  })

  it('keeps the durable fence when deployment is deferred', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '0.2.0+def456',
      code: 'orcad_update_terminals_running',
      reason: 'Terminals are still live.'
    })

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).resolves.toMatchObject({
      outcome: 'deferred',
      code: 'orcad_update_terminals_running',
      forceable: true
    })

    expect(mocks.closeTunnel).toHaveBeenCalledWith('environment-1')
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
    expect(mocks.addEnvironment).not.toHaveBeenCalled()
  })

  it('marks an ownership refusal non-forceable and keeps the durable fence', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '0.2.0+def456',
      code: 'orcad_initial_runtime_live',
      reason: 'An unmanaged runtime owns the data root.'
    })

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1',
        force: true
      })
    ).resolves.toMatchObject({
      outcome: 'deferred',
      code: 'orcad_initial_runtime_live',
      forceable: false
    })

    expect(mocks.releaseTarget).not.toHaveBeenCalled()
  })

  it('keeps the durable fence after a failed connection or deployment', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('SSH unavailable'))

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).rejects.toThrow('SSH unavailable')

    expect(mocks.closeTunnel).toHaveBeenCalledWith('environment-1')
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
  })

  it('does not contact SSH when the fenced target generation cannot flush', async () => {
    migrationStore.flushPendingOrThrowAsync.mockRejectedValueOnce(new Error('generation disk full'))

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).rejects.toThrow('generation disk full')

    expect(operationOrder).toEqual(['assert', 'begin', 'ensure-generation'])
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.deploy).not.toHaveBeenCalled()
    expect(mocks.addEnvironment).not.toHaveBeenCalled()
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
  })

  it('rejects a server-name collision before fencing the SSH target', async () => {
    mocks.listEnvironments.mockReturnValueOnce([
      { ...managedEnvironment, id: 'environment-other', name: 'Managed server' }
    ])

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).rejects.toThrow('A server named "Managed server" already exists.')

    expect(targetStore.assertOrcadRuntimeTargetClaimable).not.toHaveBeenCalled()
    expect(mocks.beginCutover).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('reconciles an interrupted first activation before retrying deployment', async () => {
    mocks.recover.mockResolvedValueOnce({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: null,
      readiness: null
    })

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).resolves.toMatchObject({ outcome: 'created' })

    expect(mocks.readRecord).toHaveBeenCalledOnce()
    expect(mocks.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ census: { liveSessions: 0, startedSinceActivation: 0 } })
    )
  })

  it('keeps a fresh first-activation fence claimed for a later retry', async () => {
    mocks.recover.mockResolvedValueOnce({
      outcome: 'pending',
      code: 'orcad_recovery_transaction_still_fresh',
      reason: 'Retry after the recovery window.'
    })

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).rejects.toThrow('Retry after the recovery window')

    expect(mocks.deploy).not.toHaveBeenCalled()
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
  })

  it('reuses the journal environment id when a deferred deployment is forced later', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '0.2.0+def456',
      code: 'orcad_update_terminals_running',
      reason: 'Terminals are still live.'
    })

    await createManagedOrcadEnvironment('/user-data', {
      name: 'Managed server',
      sshTargetId: 'ssh-1'
    })
    mocks.listCutovers.mockReturnValue([sourceCutover])
    await createManagedOrcadEnvironment('/user-data', {
      name: 'Managed server',
      sshTargetId: 'ssh-1',
      force: true
    })

    expect(mocks.beginCutover).toHaveBeenCalledTimes(2)
    expect(mocks.beginCutover).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        destinationEnvironmentId: 'environment-1',
        manifest: migrationManifest
      })
    )
    expect(mocks.createManifest).toHaveBeenCalledOnce()
    expect(mocks.addEnvironment).toHaveBeenCalledOnce()
  })

  it('keeps the source fence when the local environment write fails', async () => {
    mocks.addEnvironment.mockImplementationOnce(() => {
      throw new Error('environment disk full')
    })

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).rejects.toThrow('environment disk full')

    expect(mocks.commitDestination).not.toHaveBeenCalled()
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
    expect(mocks.closeTunnel).toHaveBeenCalledWith('environment-1')
  })

  it('keeps the registered environment and source fence when destination commit fails', async () => {
    mocks.commitDestination.mockRejectedValueOnce(new Error('commit unavailable'))

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).rejects.toThrow('commit unavailable')

    expect(mocks.addEnvironment).toHaveBeenCalledOnce()
    expect(mocks.retireSource).not.toHaveBeenCalled()
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
    expect(mocks.closeTunnel).not.toHaveBeenCalled()
  })

  it('resumes catalog commit and retirement from an existing environment', async () => {
    mocks.listCutovers.mockReturnValue([sourceCutover])
    mocks.listEnvironments.mockReturnValue([managedEnvironment])
    mocks.resolveContext.mockResolvedValueOnce({
      activationRecord: {
        active: '0.1.0+abc123',
        previous: null,
        activatedAt: '2026-08-30T00:01:00.000Z',
        snapshot: null
      },
      bunTarget: 'linux-x64-glibc',
      connection: {},
      host: { platform: 'linux', pathFlavor: 'posix', commandDialect: 'posix' },
      remoteHome: '/home/deploy',
      target: claimedTarget,
      userDataDir: '/home/deploy/.orca'
    })

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).resolves.toMatchObject({
      outcome: 'already-current',
      activeVersion: '0.1.0+abc123',
      environment: managedEnvironment
    })

    expect(mocks.ensureTunnel).toHaveBeenCalledWith('/user-data', 'environment-1')
    expect(mocks.commitDestination).toHaveBeenCalledWith(
      expect.objectContaining({ migrationId: 'migration-1', pairingCode: 'orca://pair?existing' })
    )
    expect(mocks.retireSource).toHaveBeenCalledOnce()
    expect(mocks.materialize).not.toHaveBeenCalled()
    expect(mocks.deploy).not.toHaveBeenCalled()
  })

  it.each([
    'source-fenced',
    'destination-staged',
    'destination-committed',
    'source-retired'
  ] as const)('repairs a downgraded environment link from the %s journal phase', async (phase) => {
    const cutover = { ...sourceCutover, phase }
    const downgradedEnvironment = { ...managedEnvironment, orcadDeployment: undefined }
    mocks.listCutovers.mockReturnValue([cutover])
    mocks.beginCutover.mockResolvedValueOnce(cutover)
    mocks.listEnvironments.mockReturnValue([downgradedEnvironment])
    mocks.resolveContext.mockResolvedValueOnce({
      activationRecord: {
        active: '0.1.0+abc123',
        previous: null,
        activatedAt: '2026-08-30T00:01:00.000Z',
        snapshot: null
      },
      bunTarget: 'linux-x64-glibc',
      connection: {},
      host: { platform: 'linux', pathFlavor: 'posix', commandDialect: 'posix' },
      remoteHome: '/home/deploy',
      target: claimedTarget,
      userDataDir: '/home/deploy/.orca'
    })

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).resolves.toMatchObject({ outcome: 'already-current', environment: managedEnvironment })

    expect(mocks.restoreEnvironmentLink).toHaveBeenCalledWith('/user-data', 'environment-1', {
      sshTargetId: 'ssh-1',
      sshTargetGeneration: 7,
      remotePort: 6_768
    })
    expect(mocks.ensureTunnel).toHaveBeenCalledWith('/user-data', 'environment-1')
    expect(mocks.deploy).not.toHaveBeenCalled()
  })
})

describe('listPendingManagedOrcadMigrations', () => {
  it('keeps a restart-visible recovery row until the environment is registered', () => {
    mocks.listCutovers.mockReturnValue([sourceCutover])

    expect(listPendingManagedOrcadMigrations('/user-data')).toEqual([
      {
        environmentId: 'environment-1',
        name: 'Managed server',
        sshTargetId: 'ssh-1',
        sshTargetLabel: 'Server',
        phase: 'source-fenced',
        startedAt: '2026-08-30T00:00:00.000Z'
      }
    ])

    mocks.listEnvironments.mockReturnValue([managedEnvironment])
    expect(listPendingManagedOrcadMigrations('/user-data')).toEqual([])
  })

  it('keeps a same-id environment visible when downgrade stripped its managed link', () => {
    mocks.listCutovers.mockReturnValue([sourceCutover])
    mocks.listEnvironments.mockReturnValue([{ ...managedEnvironment, orcadDeployment: undefined }])

    expect(listPendingManagedOrcadMigrations('/user-data')).toEqual([
      expect.objectContaining({
        environmentId: 'environment-1',
        sshTargetId: 'ssh-1',
        phase: 'source-fenced'
      })
    ])
  })

  it('keeps a legacy nameless journal resumable with the source target label', () => {
    mocks.listCutovers.mockReturnValue([{ ...sourceCutover, destinationName: undefined }])

    expect(listPendingManagedOrcadMigrations('/user-data')).toEqual([
      expect.objectContaining({
        environmentId: 'environment-1',
        name: 'Server',
        sshTargetId: 'ssh-1'
      })
    ])
  })

  it('keeps a source-retired crash resumable while its target fence remains', () => {
    mocks.listCutovers.mockReturnValue([
      {
        ...sourceCutover,
        phase: 'source-retired',
        receipt: {},
        retiredAt: '2026-08-30T00:01:00.000Z'
      }
    ])

    expect(listPendingManagedOrcadMigrations('/user-data')).toEqual([
      expect.objectContaining({
        environmentId: 'environment-1',
        phase: 'source-retired'
      })
    ])
  })

  it('does not turn a completed unlink receipt into a pending setup', () => {
    mocks.listCutovers.mockReturnValue([
      {
        ...sourceCutover,
        phase: 'source-retired',
        receipt: {},
        retiredAt: '2026-08-30T00:01:00.000Z'
      }
    ])
    targetStore.getTarget.mockReturnValueOnce(target)

    expect(listPendingManagedOrcadMigrations('/user-data')).toEqual([])
  })
})

describe('getManagedOrcadRuntimeStatus', () => {
  it('keeps read-only status available during reconciliation', async () => {
    mocks.resolveEnvironment.mockReturnValue({
      ...managedEnvironment,
      reconciliation: { stage: 'prepared' }
    })
    await expect(
      getManagedOrcadRuntimeStatus('/user-data', 'environment-1')
    ).resolves.toMatchObject({
      environmentId: 'environment-1'
    })
    expect(mocks.deploy).not.toHaveBeenCalled()
    expect(mocks.stopRemote).not.toHaveBeenCalled()
  })
  it('reports a registered environment whose catalog cutover is incomplete', async () => {
    mocks.listCutovers.mockReturnValue([sourceCutover])

    await expect(
      getManagedOrcadRuntimeStatus('/user-data', 'environment-1')
    ).resolves.toMatchObject({
      environmentId: 'environment-1',
      migration: {
        phase: 'source-fenced',
        startedAt: '2026-08-30T00:00:00.000Z'
      },
      recovery: null
    })
  })
})

describe('stopManagedOrcadEnvironment', () => {
  it('refuses pending reconciliation before connecting, stopping or clearing local storage', async () => {
    mocks.resolveEnvironment.mockReturnValue({
      ...managedEnvironment,
      reconciliation: { stage: 'prepared' }
    })
    const cleanupLocalState = vi.fn()
    const result = await stopManagedOrcadEnvironment(
      '/user-data',
      { selector: 'environment-1' },
      {
        invalidateTransport: vi.fn(),
        cleanupLocalState,
        isActiveEnvironment: () => false
      }
    )
    expect(result).toMatchObject({ verdict: 'unverifiable' })
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.stopRemote).not.toHaveBeenCalled()
    expect(cleanupLocalState).not.toHaveBeenCalled()
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
  })

  it('stops, retires transport, removes the environment, and releases the target', async () => {
    const invalidateTransport = vi.fn().mockResolvedValue(undefined)
    const cleanupLocalState = vi.fn().mockResolvedValue(undefined)

    const result = await stopManagedOrcadEnvironment(
      '/user-data',
      { selector: 'environment-1' },
      { invalidateTransport, cleanupLocalState, isActiveEnvironment: () => false }
    )

    expect(mocks.stopRemote).toHaveBeenCalledOnce()
    const adapter = mocks.stopRemote.mock.calls[0]![0].managedStop
    const authority = originalStopAuthority
    await adapter.readIdentity('version')
    await adapter.requestDecommission('version', authority)
    expect(mocks.readManagedIdentity).toHaveBeenCalledWith(expect.any(Object), 'version')
    expect(mocks.requestManagedDecommission).toHaveBeenCalledWith(
      expect.any(Object),
      'version',
      authority
    )
    expect(mocks.closeTunnel).toHaveBeenCalledWith('environment-1')
    expect(invalidateTransport).toHaveBeenCalledWith('environment-1')
    expect(cleanupLocalState).toHaveBeenCalledWith('environment-1')
    expect(mocks.releaseTarget).toHaveBeenCalledWith('ssh-1', 'environment-1')
    expect(mocks.removeEnvironment).toHaveBeenCalledWith('/user-data', 'environment-1')
    expect(result).toMatchObject({
      outcome: 'unlinked',
      verdict: 'exited',
      sshTargetId: 'ssh-1'
    })
  })

  it('keeps exited decommission retryable when local browser cleanup fails', async () => {
    const invalidateTransport = vi.fn().mockResolvedValue(undefined)
    const cleanupLocalState = vi.fn().mockRejectedValue(new Error('partition busy'))

    await expect(
      stopManagedOrcadEnvironment(
        '/user-data',
        { selector: 'environment-1' },
        { invalidateTransport, cleanupLocalState, isActiveEnvironment: () => false }
      )
    ).resolves.toMatchObject({
      outcome: 'failed',
      verdict: 'exited',
      code: 'orcad_unlink_local_cleanup_failed'
    })

    expect(mocks.releaseTarget).not.toHaveBeenCalled()
    expect(mocks.removeEnvironment).not.toHaveBeenCalled()
  })

  it('keeps the environment and target ownership when atomic decommission is refused', async () => {
    mocks.stopRemote.mockResolvedValueOnce({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_unverifiable',
      reason: 'The host could not fence terminal admission.'
    })
    const invalidateTransport = vi.fn()

    await expect(
      stopManagedOrcadEnvironment(
        '/user-data',
        { selector: 'environment-1' },
        { invalidateTransport, isActiveEnvironment: () => false }
      )
    ).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_unverifiable'
    })

    expect(mocks.stopRemote).toHaveBeenCalledOnce()
    expect(invalidateTransport).not.toHaveBeenCalled()
    expect(mocks.removeEnvironment).not.toHaveBeenCalled()
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
  })

  it('reports loss of contact during stop as unverifiable without local unlink', async () => {
    mocks.stopRemote.mockRejectedValueOnce(new Error('SSH channel closed'))
    const invalidateTransport = vi.fn()

    await expect(
      stopManagedOrcadEnvironment(
        '/user-data',
        { selector: 'environment-1' },
        { invalidateTransport, isActiveEnvironment: () => false }
      )
    ).resolves.toMatchObject({
      outcome: 'failed',
      verdict: 'unverifiable',
      code: 'orcad_stop_process_unverifiable'
    })

    expect(invalidateTransport).not.toHaveBeenCalled()
    expect(mocks.removeEnvironment).not.toHaveBeenCalled()
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
  })

  it('does not unlink a server selected as Active while local cleanup is in flight', async () => {
    let becameActive = false
    const invalidateTransport = vi.fn().mockResolvedValue(undefined)
    const cleanupLocalState = vi.fn().mockImplementation(async () => {
      becameActive = true
    })

    await expect(
      stopManagedOrcadEnvironment(
        '/user-data',
        { selector: 'environment-1' },
        {
          invalidateTransport,
          cleanupLocalState,
          isActiveEnvironment: () => becameActive
        }
      )
    ).resolves.toMatchObject({
      outcome: 'failed',
      verdict: 'exited',
      code: 'orcad_unlink_became_active'
    })

    expect(mocks.releaseTarget).not.toHaveBeenCalled()
    expect(mocks.removeEnvironment).not.toHaveBeenCalled()
  })
})

describe('recoverManagedOrcadEnvironment', () => {
  it('rechecks reconciliation after an update waits for lifecycle ownership', async () => {
    const gate = Promise.withResolvers<void>()
    const holding = runTargetLifecycle('ssh-1', () => gate.promise)
    const updating = updateManagedOrcadEnvironment('/user-data', { selector: 'environment-1' })
    const rejected = expect(updating).rejects.toThrow('reconciliation')
    mocks.resolveEnvironment.mockReturnValue({
      ...managedEnvironment,
      reconciliation: { stage: 'prepared' }
    })
    gate.resolve()
    await holding
    await rejected
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.deploy).not.toHaveBeenCalled()
  })
  it.each(['update', 'rollback', 'recover'] as const)(
    'fences %s before remote side effects during reconciliation',
    async (operation) => {
      mocks.resolveEnvironment.mockReturnValue({
        ...managedEnvironment,
        reconciliation: { stage: 'prepared' }
      })
      const args = { selector: 'environment-1' }
      const pending =
        operation === 'update'
          ? updateManagedOrcadEnvironment('/user-data', args)
          : operation === 'rollback'
            ? rollbackManagedOrcadEnvironment('/user-data', args)
            : recoverManagedOrcadEnvironment('/user-data', args, {
                isActiveEnvironment: () => false
              })
      await expect(pending).rejects.toThrow('reconciliation')
      expect(mocks.connect).not.toHaveBeenCalled()
      expect(mocks.deploy).not.toHaveBeenCalled()
      expect(mocks.recover).not.toHaveBeenCalled()
    }
  )
  const recover = () =>
    recoverManagedOrcadEnvironment(
      '/user-data',
      { selector: 'environment-1' },
      { isActiveEnvironment: () => false }
    )
  it('refreshes pairing and tunnel state after restoring a serving runtime', async () => {
    mocks.recover.mockResolvedValueOnce({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: '0.1.0+abc123',
      readiness
    })

    await expect(recover()).resolves.toMatchObject({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: '0.1.0+abc123',
      environment: managedEnvironment
    })

    expect(mocks.tunnelPairingCode).toHaveBeenCalledWith(readiness, 46_768)
    expect(mocks.updateEnvironment).toHaveBeenCalledWith('/user-data', 'environment-1', {
      pairingCode: 'orca://pair?managed'
    })
    expect(mocks.ensureTunnel).toHaveBeenCalledWith('/user-data', 'environment-1')
  })

  it('preserves a pending stale-window result without changing local credentials', async () => {
    mocks.recover.mockResolvedValueOnce({
      outcome: 'pending',
      code: 'orcad_recovery_transaction_still_fresh',
      reason: 'Retry later.'
    })

    await expect(recover()).resolves.toMatchObject({ outcome: 'pending' })
    expect(mocks.updateEnvironment).not.toHaveBeenCalled()
    expect(mocks.ensureTunnel).not.toHaveBeenCalled()
    const authority = originalStopAuthority
    await mocks.recover.mock.calls[0]![0].requestManagedDecommission('version', authority)
    expect(mocks.ensureTunnel).toHaveBeenCalledWith('/user-data', 'environment-1')
    expect(mocks.requestManagedDecommission).toHaveBeenCalledWith(
      managedEnvironment,
      'version',
      authority
    )
    expect(mocks.readManagedIdentity).not.toHaveBeenCalled()
    expect(mocks.requestDecommission).not.toHaveBeenCalled()
  })
})
