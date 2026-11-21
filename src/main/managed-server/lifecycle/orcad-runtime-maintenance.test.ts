import '../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listEnvironments } from '../../../shared/remote-runtime/host-store/runtime-environment-store'

import {
  moveManagedOrcadLocalPort,
  recordManagedOrcadMigration,
  refreshManagedOrcadPairing
} from '../../../shared/remote-runtime/host-store/runtime-environment-managed-orcad-store'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'

import { orcadMigrationCutoverFixture } from '../migration/cutover/testing/orcad-migration-cutover-fixture'
import { writeOrcadMigrationSourceCutover } from '../../persistence/migrating-orcad-catalog/cutover-journals/orcad-migration-cutover-journal'
import {
  createManagedLifecycleHarness,
  MANAGED_LOCAL_PORT,
  MANAGED_PREVIOUS_VERSION,
  MANAGED_VERSION,
  managedReadiness
} from './orcad-managed-lifecycle-test-fixture'

const mocks = vi.hoisted(() => {
  const state: { store: unknown } = { store: null }
  return {
    state,
    resolveContext: vi.fn(),
    census: vi.fn(),
    deploy: vi.fn(),
    rollback: vi.fn(),
    recover: vi.fn(),
    probe: vi.fn(),
    buildHash: vi.fn(),
    ensureTunnel: vi.fn(),
    rebuildTunnel: vi.fn(),
    wake: vi.fn(),
    pendingMigration: vi.fn()
  }
})

vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  getSshConnectionManager: () => ({ connect: async () => ({}) }),
  getSshTargetRegistryStore: () => mocks.state.store
}))
vi.mock('../install/orcad-remote-context', () => ({
  resolveOrcadRemoteContext: mocks.resolveContext
}))
vi.mock('./orcad-terminal-census-client', () => ({ collectManagedTerminalCensus: mocks.census }))
vi.mock('../install/orcad-remote-deploy', () => ({ deployOrcad: mocks.deploy }))
vi.mock('../install/orcad-remote-rollback', () => ({
  rollbackOrcad: mocks.rollback
}))
vi.mock('../activation/orcad-activation-recovery', () => ({
  recoverInterruptedOrcadActivation: mocks.recover
}))
vi.mock('../activation/orcad-active-readiness', () => ({ probeActiveOrcadReadiness: mocks.probe }))
vi.mock('../install/orcad-remote-build-hash', () => ({
  readRemoteOrcadBuildHash: mocks.buildHash
}))
vi.mock('../../orcad/artifact-slots/orcad-artifact-materializer', () => ({
  materializeOrcadArtifact: async () => '/local/orcad'
}))
vi.mock('../install/orcad-local-build-hash', () => ({
  computeLocalOrcadBuildHash: () => 'local-hash'
}))
vi.mock('./orcad-managed-tunnel', () => ({
  ensureOrcadManagedTunnel: mocks.ensureTunnel,
  rebuildOrcadManagedTunnel: mocks.rebuildTunnel
}))
vi.mock('./orcad-managed-wake', () => ({
  wakeStoppedManagedOrcad: mocks.wake
}))
vi.mock('./orcad-managed-migration-status', () => ({
  findIncompleteManagedOrcadMigration: mocks.pendingMigration
}))
vi.mock('../activation/orcad-activation-transaction-store', () => ({
  readOrcadActivationTransaction: async () => null
}))

const { getManagedOrcadRuntimeStatus } = await import('./orcad-runtime-status')
const { updateManagedOrcadEnvironment } = await import('./orcad-runtime-maintenance')
const { recoverManagedOrcadEnvironment } = await import('./orcad-managed-recovery')
const { rollbackManagedOrcadEnvironment } = await import('./orcad-managed-rollback')

const idle = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 7 }
let harness: Awaited<ReturnType<typeof createManagedLifecycleHarness>>

beforeEach(async () => {
  vi.resetAllMocks()
  harness = await createManagedLifecycleHarness()
  mocks.state.store = harness.targetStore
  mocks.resolveContext.mockImplementation(async () => harness.context())
  mocks.census.mockResolvedValue(idle)
  mocks.probe.mockResolvedValue(managedReadiness())
  mocks.buildHash.mockResolvedValue('previous-hash')
  mocks.recover.mockResolvedValue({ outcome: 'none' })
  mocks.wake.mockResolvedValue({ outcome: 'serving' })
})

afterEach(() => rmSync(harness.userDataPath, { recursive: true, force: true }))

async function expectEnrolledPairing(): Promise<void> {
  const [environment] = await listEnvironments(harness.userDataPath)
  expect(environment?.endpoints[0]?.deviceToken).toBe('device-token')
  expect(environment?.pairingRevision).toBe(harness.environment.pairingRevision)
  expect(environment?.orcadDeployment).toEqual(harness.environment.orcadDeployment)
}

describe('updateManagedOrcadEnvironment', () => {
  it('defers over live or unverifiable terminals and reports the deferral in status', async () => {
    mocks.census.mockResolvedValue({ ...idle, liveSessions: null })
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '0.3.0+new',
      code: 'orcad_update_terminal_census_unavailable',
      reason: 'The terminal daemon did not answer a session count.'
    })
    const result = await updateManagedOrcadEnvironment(harness.userDataPath, {
      selector: 'Managed'
    })
    expect(result).toMatchObject({ outcome: 'deferred', forceable: false })
    expect(mocks.deploy.mock.calls[0]?.[0]).toMatchObject({
      census: { liveSessions: null },
      port: 6_768,
      nodePath: ''
    })
    const status = await getManagedOrcadRuntimeStatus(harness.userDataPath, 'Managed')
    expect(status.deferredUpdate).toMatchObject({
      candidateVersion: '0.3.0+new',
      code: 'orcad_update_terminal_census_unavailable'
    })
    expect(status.terminals.liveSessions).toBeNull()
  })

  it('clears the deferral once an update goes through and keeps an unchanged pairing as is', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '0.3.0+new',
      code: 'orcad_update_terminals_running',
      reason: 'busy'
    })
    await updateManagedOrcadEnvironment(harness.userDataPath, { selector: 'Managed' })
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-and-activated',
      fullVersion: '0.3.0+new'
    })
    const result = await updateManagedOrcadEnvironment(harness.userDataPath, {
      selector: 'Managed',
      force: true
    })
    expect(result).toMatchObject({ outcome: 'updated', activeVersion: '0.3.0+new' })
    expect(mocks.probe).toHaveBeenCalledWith(expect.anything(), {
      buildHash: 'local-hash',
      fullVersion: '0.3.0+new'
    })
    const [environment] = await listEnvironments(harness.userDataPath)
    expect(environment?.pairingRevision).toBe(harness.environment.pairingRevision)
    expect(environment?.orcadDeployment).toEqual(harness.environment.orcadDeployment)
    const status = await getManagedOrcadRuntimeStatus(harness.userDataPath, 'Managed')
    expect(status.deferredUpdate).toBeNull()
  })

  it('still reports the activation when the new forward cannot be built yet', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.deploy.mockResolvedValueOnce({ outcome: 'installed-and-activated', fullVersion: 'v3' })
    mocks.rebuildTunnel.mockRejectedValueOnce(new Error('ssh connect failed'))
    await expect(
      updateManagedOrcadEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'updated', activeVersion: 'v3' })
  })

  it('keeps a pairing the terminal count repaired, not the one read before it', async () => {
    mocks.census.mockImplementationOnce(async () => {
      await refreshManagedOrcadPairing(
        harness.userDataPath,
        'environment-1',
        encodePairingOffer({
          v: PAIRING_OFFER_VERSION,
          endpoint: `ws://127.0.0.1:${MANAGED_LOCAL_PORT}/`,
          deviceToken: 'repaired-token',
          publicKeyB64: 'public-key'
        })
      )
      return idle
    })
    mocks.deploy.mockResolvedValueOnce({ outcome: 'already-active', fullVersion: MANAGED_VERSION })
    mocks.probe.mockResolvedValueOnce(managedReadiness('startup-offer-token'))
    await updateManagedOrcadEnvironment(harness.userDataPath, { selector: 'Managed' })
    const [environment] = await listEnvironments(harness.userDataPath)
    expect(environment?.endpoints[0]?.deviceToken).toBe('repaired-token')
  })

  it('keeps the enrolled grant when the updated server offers a new device', async () => {
    mocks.deploy.mockResolvedValueOnce({ outcome: 'installed-and-activated', fullVersion: 'v3' })
    mocks.probe.mockResolvedValueOnce(managedReadiness('startup-offer-token'))
    await updateManagedOrcadEnvironment(harness.userDataPath, { selector: 'Managed' })
    await expectEnrolledPairing()
  })

  it('saves the new pairing on the tunnel port the census moved to', async () => {
    mocks.census.mockImplementationOnce(async () => {
      await moveManagedOrcadLocalPort(harness.userDataPath, 'environment-1', MANAGED_LOCAL_PORT + 1)
      return idle
    })
    mocks.deploy.mockResolvedValueOnce({ outcome: 'installed-and-activated', fullVersion: 'v3' })
    mocks.probe.mockResolvedValueOnce(managedReadiness())

    await updateManagedOrcadEnvironment(harness.userDataPath, { selector: 'Managed' })

    const [environment] = await listEnvironments(harness.userDataPath)
    expect(environment?.orcadDeployment?.localPort).toBe(MANAGED_LOCAL_PORT + 1)
    expect(environment?.endpoints[0]?.endpoint).toBe(`ws://127.0.0.1:${MANAGED_LOCAL_PORT + 1}/`)
  })
})

describe('rollbackManagedOrcadEnvironment', () => {
  it.each([
    [{ ...idle, liveSessions: 2 }, 'orcad_rollback_terminals_running'],
    [{ ...idle, liveSessions: null }, 'orcad_rollback_census_unavailable']
  ])('refuses while terminals run or cannot be counted: %j', async (census, code) => {
    mocks.census.mockResolvedValue(census)
    await expect(
      rollbackManagedOrcadEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', code })
    expect(mocks.rollback).not.toHaveBeenCalled()
  })

  it('refuses with no previous version without contacting the slot', async () => {
    mocks.resolveContext.mockImplementation(async () => harness.context({ previous: null }))
    await expect(
      rollbackManagedOrcadEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', code: 'orcad_rollback_no_target' })
    expect(mocks.census).not.toHaveBeenCalled()
  })

  it('refuses while a migration into the server is unfinished', async () => {
    mocks.pendingMigration.mockReturnValueOnce({ migrationId: 'm-1', phase: 'destination-staged' })
    await expect(
      rollbackManagedOrcadEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', code: 'orcad_rollback_migration_in_progress' })
    expect(mocks.rollback).not.toHaveBeenCalled()
  })

  it('refuses a rollback to a snapshot older than the migrated catalog, not a newer one', async () => {
    await recordManagedOrcadMigration(
      harness.userDataPath,
      'environment-1',
      '2026-02-01T00:00:00.000Z'
    )
    await expect(
      rollbackManagedOrcadEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', code: 'orcad_rollback_crosses_migration' })
    expect(mocks.rollback).not.toHaveBeenCalled()
    mocks.resolveContext.mockImplementation(async () =>
      harness.context({ activatedAt: '2026-03-01T00:00:00.000Z' })
    )
    mocks.rollback.mockResolvedValueOnce({ outcome: 'refused', code: 'x', reason: 'y' })
    await rollbackManagedOrcadEnvironment(harness.userDataPath, { selector: 'Managed' })
    expect(mocks.rollback).toHaveBeenCalledOnce()
  })

  it('refuses a rollback across a retained delta move that predates the mark', async () => {
    // Older deltas lack a durable mark; their retained journal must still block destructive rollback.
    writeOrcadMigrationSourceCutover(harness.userDataPath, {
      ...orcadMigrationCutoverFixture('delta-1', 'ssh-1', { environmentId: 'environment-1' }),
      startedAt: '2026-02-01T00:00:00.000Z',
      phase: 'destination-committed',
      sourceRetainedAt: '2026-02-01T00:00:00.000Z'
    })
    await expect(
      rollbackManagedOrcadEnvironment(harness.userDataPath, { selector: 'Managed' })
    ).resolves.toMatchObject({ outcome: 'refused', code: 'orcad_rollback_crosses_migration' })
    expect(mocks.rollback).not.toHaveBeenCalled()
  })

  it('keeps the enrolled grant when the restored server offers a new device', async () => {
    mocks.rollback.mockResolvedValueOnce({
      outcome: 'rolled-back',
      target: MANAGED_PREVIOUS_VERSION,
      discarded: [MANAGED_VERSION],
      verdict: { decision: 'activate', coverage: 'pty-spawn', warnings: [] }
    })
    mocks.probe.mockResolvedValueOnce(managedReadiness('startup-offer-token'))
    await rollbackManagedOrcadEnvironment(harness.userDataPath, { selector: 'Managed' })
    await expectEnrolledPairing()
  })
})

describe('recoverManagedOrcadEnvironment', () => {
  it('keeps the enrolled grant when the recovered server offers a new device', async () => {
    mocks.recover.mockResolvedValueOnce({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: MANAGED_VERSION,
      readiness: managedReadiness('startup-offer-token')
    })
    await recoverManagedOrcadEnvironment(harness.userDataPath, { selector: 'Managed' })
    await expectEnrolledPairing()
  })
})
