import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAppEnvironment } from '../../shared/app-environment'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { writeOrcadMigrationSourceCutover } from './orcad-migration-cutover-journal'
import { orcadMigrationCutoverFixture } from './orcad-migration-cutover-fixture'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { SshTarget } from '../../shared/ssh-types'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { SshTargetOrcadClaims } from './ssh-target-orcad-claims'
import { emptyDependentStateStore } from './ssh-target-orcad-dependents-fixture'
import {
  withDeactivatedVersion,
  withDeactivatedVersionCommitted,
  type OrcadActivationRecord
} from './orcad-activation-record'
import { ORCAD_ACTIVATION_POLICY_REFUSED_CODE } from './orcad-installed-activation'
import type { OrcadDeployOptions } from './orcad-remote-deploy'

const mocks = vi.hoisted(() => {
  const state: { store: unknown } = { store: null }
  return {
    state,
    events: new Array<string>(),
    connect: vi.fn(),
    hasDirectAuthority: vi.fn(),
    resolveContext: vi.fn(),
    recover: vi.fn(),
    readRecord: vi.fn(),
    deploy: vi.fn(),
    probe: vi.fn(),
    startTunnel: vi.fn(),
    ensureTunnel: vi.fn(),
    closeTunnel: vi.fn(),
    readTransaction: vi.fn()
  }
})

vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: () => ({ connect: mocks.connect }),
  getSshTargetRegistryStore: () => mocks.state.store,
  hasRegisteredDirectSshAuthority: mocks.hasDirectAuthority
}))
vi.mock('./orcad-remote-context', () => ({ resolveOrcadRemoteContext: mocks.resolveContext }))
vi.mock('./orcad-activation-recovery', () => ({ recoverInterruptedOrcadActivation: mocks.recover }))
vi.mock('./orcad-activation-record-store', () => ({ readOrcadActivationRecord: mocks.readRecord }))
vi.mock('./orcad-activation-transaction-store', () => ({
  readOrcadActivationTransaction: mocks.readTransaction
}))
vi.mock('./orcad-remote-deploy', () => ({ deployOrcad: mocks.deploy }))
vi.mock('./orcad-artifact-materializer', () => ({
  materializeOrcadArtifact: async () => '/local/orcad'
}))
vi.mock('./orcad-local-build-hash', () => ({ computeLocalOrcadBuildHash: () => 'build-hash' }))
vi.mock('./orcad-active-readiness', () => ({ probeActiveOrcadReadiness: mocks.probe }))
vi.mock('./orcad-terminal-census-client', () => ({
  collectManagedTerminalCensus: async () => ({
    liveSessions: 0,
    startedSinceActivation: 0,
    daemonProtocolVersion: 39
  })
}))
vi.mock('./orcad-managed-tunnel', () => ({
  startOrcadManagedTunnel: mocks.startTunnel,
  ensureOrcadManagedTunnel: mocks.ensureTunnel,
  closeOrcadManagedTunnel: mocks.closeTunnel
}))

const { createManagedOrcadEnvironment, getManagedOrcadRuntimeStatus } =
  await import('./orcad-runtime-lifecycle')

const VERSION = '0.1.0+abc123'
const emptyRecord = { active: null, previous: null, activatedAt: null, snapshot: null }

function readiness(endpoint = 'ws://127.0.0.1:6768') {
  return {
    runtimeId: 'runtime-1',
    boundEndpoint: endpoint,
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: {
      available: true,
      url: encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint,
        deviceToken: 'device-token',
        publicKeyB64: 'public-key'
      }),
      endpoint,
      deviceId: 'device-1',
      webClientUrl: null,
      scope: 'runtime',
      qr: null
    }
  }
}

let userDataPath: string
let target: SshTarget
let flushes: number

function setupStore(overrides: { repos?: { connectionId: string }[] } = {}) {
  const store = {
    allocateSshTargetGeneration: () => 9,
    flushPendingOrThrowAsync: async () => {
      flushes += 1
      mocks.events.push('flush')
    },
    getFolderWorkspaces: () => [],
    getRepos: () => overrides.repos ?? [],
    ...emptyDependentStateStore(),
    getSshTarget: (id: string) => (id === target.id ? target : undefined),
    getSshTargets: () => [target],
    updateSshTarget: (_id: string, updates: Partial<SshTarget>) => {
      target = { ...target, ...updates }
      return target
    }
  }
  mocks.state.store = {
    getTarget: (id: string) => (id === target.id ? target : undefined),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the claims read only the store methods stubbed above.
    getOrcadRuntimeClaims: () => new SshTargetOrcadClaims(store as never)
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.events.length = 0
  flushes = 0
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-deployment-test-'))
  target = { id: 'ssh-1', label: 'Builder', host: 'builder', port: 22, username: 'dev' }
  setupStore()
  mocks.hasDirectAuthority.mockReturnValue(false)
  mocks.connect.mockImplementation(async () => {
    mocks.events.push('connect')
    return {}
  })
  mocks.resolveContext.mockImplementation(async (claimed: SshTarget) => ({
    activationRecord: emptyRecord,
    serverTarget: 'linux-x64-glibc',
    connection: {},
    host: getRemoteHostPlatform('linux-x64'),
    remoteHome: '/home/dev',
    target: claimed,
    userDataDir: '/home/dev/.orca'
  }))
  mocks.recover.mockResolvedValue({ outcome: 'none' })
  mocks.deploy.mockResolvedValue({ outcome: 'installed-and-activated', fullVersion: VERSION })
  mocks.probe.mockResolvedValue(readiness())
  mocks.startTunnel.mockResolvedValue(46_768)
  mocks.closeTunnel.mockResolvedValue(undefined)
  mocks.ensureTunnel.mockResolvedValue(undefined)
})

afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

const deploy = () =>
  createManagedOrcadEnvironment(userDataPath, { name: 'Managed', sshTargetId: 'ssh-1' })

describe('createManagedOrcadEnvironment', () => {
  it('claims the target durably before contacting it, then registers a tunneled server', async () => {
    const result = await deploy()

    expect(mocks.events.slice(0, 2)).toEqual(['flush', 'connect'])
    expect(result).toMatchObject({ outcome: 'created', activeVersion: VERSION })
    const [environment] = listEnvironments(userDataPath)
    expect(environment?.orcadDeployment).toEqual({
      sshTargetId: 'ssh-1',
      sshTargetGeneration: 9,
      localPort: 46_768,
      remotePort: 6_768
    })
    expect(environment?.connectionDependency).toBe('ssh-tunnel')
    expect(getManagedOrcadFenceEnvironmentId(target)).toBe(environment?.id)
    expect(target.orcadProvisioning).toEqual({ requestId: environment?.id, name: 'Managed' })
    expect(JSON.stringify(result)).not.toContain('device-token')
    expect(mocks.probe).toHaveBeenCalledWith(
      expect.objectContaining({ remoteInstallDir: expect.any(String) }),
      {
        buildHash: 'build-hash',
        fullVersion: VERSION
      }
    )
    expect(mocks.closeTunnel).not.toHaveBeenCalled()
  })

  it('tunnels to the port orcad bound when 6768 is taken, and keeps 6768 as its launch port', async () => {
    mocks.probe.mockResolvedValue(readiness('ws://127.0.0.1:58520'))
    await deploy()

    const [, , , remotePort, checks] = mocks.startTunnel.mock.calls[0] ?? []
    expect(remotePort).toBe(58_520)
    expect(checks).toMatchObject({ preferredPort: 6_768 })
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment?.remotePort).toBe(6_768)
  })

  it('deploys an empty host with a zero census and an unknown one over an active slot', async () => {
    await deploy()
    expect(mocks.deploy.mock.calls[0]?.[0]).toMatchObject({
      census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null },
      nodePath: ''
    })
  })

  describe('admitting a host another desktop stopped, under the fence', () => {
    const servedBy = (appVersion: string | null, active: string): OrcadActivationRecord => ({
      schemaVersion: 1,
      active,
      previous: null,
      activatedAt: '2026-10-01T00:00:00.000Z',
      snapshot: null,
      ...(appVersion ? { activeAppVersion: appVersion } : {})
    })
    const admitOn = async (
      record: OrcadActivationRecord,
      options: { force?: boolean } = {}
    ): Promise<{ admitted: string | null; result: unknown }> => {
      vi.spyOn(getAppEnvironment(), 'getVersion').mockReturnValue('1.5.0')
      let admitted: string | null = null
      mocks.deploy.mockImplementationOnce(async (deployOptions: OrcadDeployOptions) => {
        admitted = deployOptions.admitRecord?.(record, VERSION) ?? null
        return admitted
          ? {
              outcome: 'installed-not-activated',
              fullVersion: VERSION,
              code: ORCAD_ACTIVATION_POLICY_REFUSED_CODE,
              reason: admitted
            }
          : { outcome: 'installed-and-activated', fullVersion: VERSION }
      })
      const result = await createManagedOrcadEnvironment(userDataPath, {
        name: 'Managed',
        sshTargetId: 'ssh-1',
        ...options
      })
      return { admitted, result }
    }

    it('redeploys a host an older build stopped without naming its version', async () => {
      // What every Stop that predates keeping the app version commits.
      const legacy = withDeactivatedVersion(servedBy('1.4.0', '0.1.0+old'))
      expect(legacy.activeAppVersion).toBeUndefined()
      const { admitted, result } = await admitOn(legacy)
      expect(admitted).toBeNull()
      expect(result).toMatchObject({ outcome: 'created', activeVersion: VERSION })
    })

    it('refuses an older build on a host a newer desktop stopped, naming both versions', async () => {
      const stopped = withDeactivatedVersionCommitted(servedBy('1.6.0', '0.1.0+new'))
      const { admitted, result } = await admitOn(stopped)
      expect(admitted).toContain('Orca 1.6.0')
      expect(admitted).toContain('(1.5.0)')
      expect(result).toMatchObject({
        outcome: 'deferred',
        code: ORCAD_ACTIVATION_POLICY_REFUSED_CODE,
        forceable: true
      })
    })

    it('redeploys a host the same Orca version stopped', async () => {
      const stopped = withDeactivatedVersionCommitted(servedBy('1.5.0', '0.1.0+other'))
      const { admitted, result } = await admitOn(stopped)
      expect(admitted).toBeNull()
      expect(result).toMatchObject({ outcome: 'created' })
    })

    it('restarts the stopped build itself even when a newer desktop stopped it', async () => {
      const stopped = withDeactivatedVersionCommitted(servedBy('1.6.0', VERSION))
      expect((await admitOn(stopped)).admitted).toBeNull()
    })

    it('runs this version anyway when the deploy is forced', async () => {
      const stopped = withDeactivatedVersionCommitted(servedBy('1.6.0', '0.1.0+new'))
      const { admitted, result } = await admitOn(stopped, { force: true })
      expect(admitted).toBeNull()
      expect(result).toMatchObject({ outcome: 'created' })
    })
  })

  it('refuses a host with direct SSH projects before claiming or connecting', async () => {
    setupStore({ repos: [{ connectionId: 'ssh-1' }] })
    await expect(deploy()).rejects.toThrow('repositories or folder workspaces')
    expect(target.orcadFence).toBeUndefined()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('refuses a host that saved state still references, naming it, before claiming', async () => {
    const leases = [{ ptyId: 'pty-1', state: 'expired' }]
    const store = {
      ...emptyDependentStateStore({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census reads only ptyId and state.
        getSshRemotePtyLeases: () => leases as never
      }),
      allocateSshTargetGeneration: () => 9,
      flushPendingOrThrowAsync: async () => {},
      getFolderWorkspaces: () => [],
      getRepos: () => [],
      getSshTarget: () => target,
      getSshTargets: () => [target],
      updateSshTarget: (_id: string, updates: Partial<SshTarget>) =>
        (target = { ...target, ...updates })
    }
    mocks.state.store = {
      getTarget: () => target,
      getOrcadRuntimeClaims: () => new SshTargetOrcadClaims(store)
    }
    await expect(deploy()).rejects.toThrow('terminal-lease ×1 (pty-1 (expired))')
    expect(target.orcadFence).toBeUndefined()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('refuses a connected direct SSH session and a taken server name', async () => {
    mocks.hasDirectAuthority.mockReturnValueOnce(true)
    await expect(deploy()).rejects.toThrow('Disconnect this SSH host')
    await deploy()
    target = { ...target, id: 'ssh-2', orcadFence: undefined }
    await expect(
      createManagedOrcadEnvironment(userDataPath, { name: 'Managed', sshTargetId: 'ssh-2' })
    ).rejects.toThrow('already exists')
  })

  it('does not contact the host when the claim cannot be made durable', async () => {
    const claims = new SshTargetOrcadClaims({
      allocateSshTargetGeneration: () => 9,
      flushPendingOrThrowAsync: async () => {
        throw new Error('disk full')
      },
      getFolderWorkspaces: () => [],
      getRepos: () => [],
      ...emptyDependentStateStore(),
      getSshTarget: () => target,
      getSshTargets: () => [target],
      updateSshTarget: (_id, updates) => (target = { ...target, ...updates })
    })
    mocks.state.store = { getTarget: () => target, getOrcadRuntimeClaims: () => claims }
    await expect(deploy()).rejects.toThrow('disk full')
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('returns a deferral, keeps the claim and closes nothing it did not open', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: VERSION,
      code: 'orcad_update_terminal_census_unavailable',
      reason: 'unknown census'
    })
    await expect(deploy()).resolves.toMatchObject({ outcome: 'deferred', forceable: false })
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(getManagedOrcadFenceEnvironmentId(target)).not.toBeNull()
    expect(mocks.startTunnel).not.toHaveBeenCalled()
  })

  it('resumes an interrupted deploy under the environment id its claim recorded', async () => {
    mocks.probe.mockRejectedValueOnce(new Error('readiness unverifiable'))
    await expect(deploy()).rejects.toThrow('readiness unverifiable')
    const claimedId = getManagedOrcadFenceEnvironmentId(target)
    expect(claimedId).not.toBeNull()
    mocks.deploy.mockResolvedValueOnce({ outcome: 'already-active', fullVersion: VERSION })
    const result = await deploy()
    expect(result).toMatchObject({ outcome: 'already-current' })
    expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual([claimedId])
  })

  it('closes the tunnel it opened when registration fails', async () => {
    mocks.probe.mockResolvedValueOnce({
      ...readiness(),
      pairing: { available: false, guidance: 'off' }
    })
    mocks.startTunnel.mockResolvedValueOnce(46_768)
    await expect(deploy()).rejects.toThrow('did not publish a pairing offer')
    expect(mocks.closeTunnel).toHaveBeenCalledOnce()
    expect(JSON.stringify(mocks.closeTunnel.mock.calls)).not.toContain('device-token')
  })

  it('finishes an already registered server by ensuring its tunnel, without redeploying', async () => {
    await deploy()
    mocks.resolveContext.mockImplementation(async (claimed: SshTarget) => ({
      activationRecord: { ...emptyRecord, active: VERSION },
      serverTarget: 'linux-x64-glibc',
      connection: {},
      host: getRemoteHostPlatform('linux-x64'),
      remoteHome: '/home/dev',
      target: claimed,
      userDataDir: '/home/dev/.orca'
    }))
    await expect(deploy()).resolves.toMatchObject({ outcome: 'already-current' })
    expect(mocks.deploy).toHaveBeenCalledOnce()
    expect(mocks.ensureTunnel).toHaveBeenCalledOnce()
  })

  it('stops at an interrupted activation the host cannot reconcile yet', async () => {
    mocks.recover.mockResolvedValueOnce({
      outcome: 'pending',
      code: 'fresh',
      reason: 'still fresh'
    })
    await expect(deploy()).rejects.toThrow('still fresh')
    expect(mocks.deploy).not.toHaveBeenCalled()
  })
})

describe('createManagedOrcadEnvironment for a migration', () => {
  it('deploys into its own journaled fence without leaving a provisioning intent', async () => {
    target = { ...target, orcadFence: { environmentId: 'env-m' }, generation: 9 }
    writeOrcadMigrationSourceCutover(
      userDataPath,
      orcadMigrationCutoverFixture('m-1', 'ssh-1', { generation: 9, environmentId: 'env-m' })
    )
    await expect(
      createManagedOrcadEnvironment(userDataPath, {
        name: 'Managed',
        sshTargetId: 'ssh-1',
        migration: true
      })
    ).resolves.toMatchObject({ outcome: 'created' })
    expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual(['env-m'])
    expect(target.orcadProvisioning).toBeUndefined()
  })

  it('refuses a migration deploy whose fence has no journal, before connecting', async () => {
    target = { ...target, orcadFence: { environmentId: 'env-m' }, generation: 9 }
    await expect(
      createManagedOrcadEnvironment(userDataPath, {
        name: 'Managed',
        sshTargetId: 'ssh-1',
        migration: true
      })
    ).rejects.toThrow('orcad_migration_fence_required')
    expect(mocks.connect).not.toHaveBeenCalled()
  })
})

describe('getManagedOrcadRuntimeStatus', () => {
  it('reports the activation record and an interrupted transaction without repairing it', async () => {
    await deploy()
    const [environment] = listEnvironments(userDataPath)
    mocks.resolveContext.mockImplementation(async (claimed: SshTarget) => ({
      activationRecord: { ...emptyRecord, active: VERSION, activatedAt: 'now' },
      connection: {},
      host: getRemoteHostPlatform('linux-x64'),
      remoteHome: '/home/dev',
      target: claimed
    }))
    mocks.readTransaction.mockResolvedValueOnce({
      operation: 'activate',
      phase: 'candidate-ready',
      candidateVersion: '0.2.0+def',
      startedAt: 'then'
    })
    await expect(getManagedOrcadRuntimeStatus(userDataPath, 'Managed')).resolves.toEqual({
      environmentId: environment?.id,
      sshTargetId: 'ssh-1',
      activeVersion: VERSION,
      previousVersion: null,
      activatedAt: 'now',
      rollbackAvailable: false,
      recovery: {
        operation: 'activate',
        phase: 'candidate-ready',
        version: '0.2.0+def',
        startedAt: 'then'
      },
      terminals: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 39 },
      migration: null,
      deferredUpdate: null
    })
    expect(mocks.recover).toHaveBeenCalledTimes(1)
  })

  it('reports an interrupted decommission without finishing it', async () => {
    await deploy()
    mocks.readTransaction.mockResolvedValueOnce({
      operation: 'decommission',
      phase: 'stop-dispatched',
      activeVersion: VERSION,
      startedAt: 'then'
    })
    await expect(getManagedOrcadRuntimeStatus(userDataPath, 'Managed')).resolves.toMatchObject({
      recovery: { operation: 'decommission', phase: 'stop-dispatched', version: VERSION }
    })
  })

  it('reports an unfinished migration into the server', async () => {
    await deploy()
    const [environment] = listEnvironments(userDataPath)
    writeOrcadMigrationSourceCutover(userDataPath, {
      ...orcadMigrationCutoverFixture('m-2', 'ssh-1', {
        generation: 9,
        environmentId: environment!.id
      }),
      phase: 'destination-staged'
    })
    mocks.resolveContext.mockImplementation(async (claimed: SshTarget) => ({
      activationRecord: { ...emptyRecord, active: VERSION },
      connection: {},
      host: getRemoteHostPlatform('linux-x64'),
      remoteHome: '/home/dev',
      target: claimed
    }))
    await expect(getManagedOrcadRuntimeStatus(userDataPath, 'Managed')).resolves.toMatchObject({
      migration: { migrationId: 'm-2', phase: 'destination-staged' }
    })
  })

  it('refuses a server whose SSH registration was re-created', async () => {
    await deploy()
    target = { ...target, generation: 10 }
    await expect(getManagedOrcadRuntimeStatus(userDataPath, 'Managed')).rejects.toThrow(
      'no longer valid'
    )
  })
})
