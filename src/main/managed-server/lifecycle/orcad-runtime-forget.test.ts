import '../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedOrcadFenceEnvironmentId } from '../../../shared/managed-orcad-ssh-owner'
import { listEnvironments } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  listOrcadMigrationSourceCutovers,
  writeOrcadMigrationSourceCutover
} from '../../persistence/migrating-orcad-catalog/cutover-journals/orcad-migration-cutover-journal'
import { orcadMigrationCutoverFixture } from '../migration/cutover/testing/orcad-migration-cutover-fixture'
import { createManagedLifecycleHarness } from './orcad-managed-lifecycle-test-fixture'
import { isManagedOrcadSshTarget } from '../../ssh/targets/ssh-target-runtime-ownership'
import { addManagedOrcadEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-managed-orcad-store'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'

const mocks = vi.hoisted(() => {
  const state: { store: unknown } = { store: null }
  return {
    state,
    connect: vi.fn(),
    resolveContext: vi.fn(),
    closeTunnel: vi.fn(),
    retire: vi.fn(),
    releaseHost: vi.fn()
  }
})

vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  getSshConnectionManager: () => ({ connect: mocks.connect }),
  getSshTargetRegistryStore: () => mocks.state.store
}))
vi.mock('../install/orcad-remote-context', () => ({
  resolveOrcadRemoteContext: mocks.resolveContext
}))
vi.mock('./orcad-managed-tunnel', () => ({
  closeOrcadManagedTunnel: mocks.closeTunnel,
  ensureOrcadManagedTunnel: vi.fn()
}))

const {
  forgetManagedOrcadEnvironment,
  forgetRedundantManagedOrcadEnvironment,
  stopManagedOrcadEnvironment
} = await import('./orcad-runtime-decommission')

let harness: Awaited<ReturnType<typeof createManagedLifecycleHarness>>

const policy = (isActive = false) => ({
  isActiveEnvironment: () => isActive,
  retireLocalState: mocks.retire,
  releaseHostTransport: mocks.releaseHost
})

beforeEach(async () => {
  vi.resetAllMocks()
  harness = await createManagedLifecycleHarness()
  mocks.state.store = harness.targetStore
  mocks.connect.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:2841'))
  mocks.resolveContext.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:2841'))
})

afterEach(() => rmSync(harness.userDataPath, { recursive: true, force: true }))

describe('a managed server whose host is gone (P1-E)', () => {
  it('cannot be stopped, since the host can never prove orcad exited', async () => {
    await expect(
      stopManagedOrcadEnvironment(harness.userDataPath, { selector: 'Managed' }, policy())
    ).rejects.toThrow('ECONNREFUSED')
    expect(await listEnvironments(harness.userDataPath)).toHaveLength(1)
    expect(isManagedOrcadSshTarget(harness.current())).toBe(true)
  })

  it('is forgotten locally without contacting the host, which frees its SSH target', async () => {
    writeOrcadMigrationSourceCutover(harness.userDataPath, {
      ...orcadMigrationCutoverFixture('migration-1', 'ssh-1', { environmentId: 'environment-1' }),
      phase: 'destination-committed',
      sourceRetainedAt: '2026-10-01T00:00:00.000Z'
    })
    await expect(
      forgetManagedOrcadEnvironment(harness.userDataPath, { selector: 'Managed' }, policy())
    ).resolves.toEqual({
      outcome: 'forgotten',
      // No host observation means local forgetting cannot report proven exit.
      verdict: 'unverifiable',
      environmentId: 'environment-1',
      sshTargetId: 'ssh-1'
    })
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.resolveContext).not.toHaveBeenCalled()
    expect(await listEnvironments(harness.userDataPath)).toEqual([])
    expect(getManagedOrcadFenceEnvironmentId(harness.current())).toBeNull()
    expect(isManagedOrcadSshTarget(harness.current())).toBe(false)
    expect(harness.flushes).toHaveLength(1)
    expect(mocks.retire).toHaveBeenCalledWith('environment-1')
    expect(mocks.closeTunnel).toHaveBeenCalledWith('environment-1')
    // An unserved host never stays connected, so Set location can't offer it (#37767).
    expect(mocks.releaseHost).toHaveBeenCalledWith('ssh-1')
    expect(listOrcadMigrationSourceCutovers(harness.userDataPath)).toEqual([])
  })

  it('refuses to forget the Active Server and keeps every link', async () => {
    await expect(
      forgetManagedOrcadEnvironment(harness.userDataPath, { selector: 'Managed' }, policy(true))
    ).resolves.toMatchObject({ outcome: 'refused', code: 'orcad_forget_active_environment' })
    expect(await listEnvironments(harness.userDataPath)).toHaveLength(1)
    expect(getManagedOrcadFenceEnvironmentId(harness.current())).toBe('environment-1')
    expect(mocks.retire).not.toHaveBeenCalled()
    expect(mocks.closeTunnel).not.toHaveBeenCalled()
    expect(mocks.releaseHost).not.toHaveBeenCalled()
  })
})

describe('a managed server saved under a second SSH alias', () => {
  // Same host key in its padded spelling, reached through its own SSH target.
  const addTwin = async () =>
    await addManagedOrcadEnvironment(harness.userDataPath, {
      id: 'environment-2',
      name: 'Managed alias',
      pairingCode: encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint: 'ws://127.0.0.1:46769/',
        deviceToken: 'alias-device-token',
        publicKeyB64: 'public-key='
      }),
      orcadDeployment: {
        sshTargetId: 'ssh-2',
        sshTargetGeneration: 1,
        localPort: 46_769,
        remotePort: 6_768
      }
    })

  it('forgets the redundant entry and leaves the other one managing the server', async () => {
    await addTwin()
    await expect(
      forgetRedundantManagedOrcadEnvironment(
        harness.userDataPath,
        { selector: 'Managed' },
        policy()
      )
    ).resolves.toMatchObject({ outcome: 'forgotten', environmentId: 'environment-1' })
    expect(mocks.connect).not.toHaveBeenCalled()
    expect((await listEnvironments(harness.userDataPath)).map(({ id }) => id)).toEqual([
      'environment-2'
    ])
  })

  it('refuses when the other entry is gone by the time the removal runs', async () => {
    await expect(
      forgetRedundantManagedOrcadEnvironment(
        harness.userDataPath,
        { selector: 'Managed' },
        policy()
      )
    ).resolves.toMatchObject({ outcome: 'refused', code: 'orcad_forget_no_managed_twin' })
    expect(await listEnvironments(harness.userDataPath)).toHaveLength(1)
    expect(getManagedOrcadFenceEnvironmentId(harness.current())).toBe('environment-1')
    expect(mocks.closeTunnel).not.toHaveBeenCalled()
  })
})
