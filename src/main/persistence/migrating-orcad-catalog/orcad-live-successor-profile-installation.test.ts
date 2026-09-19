import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveSourceRetirementFixture } from './orcad-live-source-retirement-test-fixture'
import { OrcadSourceRetirementPersistence } from './orcad-source-retirement-persistence'
import { WriteSchedulingOperations } from '../loading-store/write-scheduling'
import { OrcadRetirementSessionPublication } from '../loading-store/orcad-retirement-session-publication'
import { projectOrcadSourceLiveState } from './orcad-source-live-state-projection'

let directory: string
beforeEach(() => {
  vi.useFakeTimers()
  directory = mkdtempSync(join(tmpdir(), 'orca-successor-install-'))
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const f = liveSourceRetirementFixture()
  const publication = new OrcadRetirementSessionPublication(directory)
  const schedulingRuntime = {
    automationListProjectionCache: null,
    quitFlushStarted: false,
    writeGeneration: 0,
    firstPendingSaveAt: null,
    writeTimer: null
  }
  type SchedulingArguments = ConstructorParameters<typeof WriteSchedulingOperations>
  const scheduling = new WriteSchedulingOperations(
    schedulingRuntime as unknown as SchedulingArguments[0],
    {} as SchedulingArguments[1]
  )
  const domain = new OrcadSourceRetirementPersistence(
    {
      state: f.state,
      terminalScrollbackSnapshotStorage: {},
      orcadRetirementSessionPublication: publication
    },
    scheduling
  )
  const record = domain.createOrcadLiveSourceRetirementRecord(
    {
      version: 1,
      cutover: f.cutover,
      activations: f.cutover.terminalPublications!.map((entry) => ({
        version: 1,
        identity: entry.identity,
        publicationReceipt: entry.publicationReceipt,
        destinationClaim: { generation: 1, claimId: 'claim' },
        catalog: entry.catalog
      }))
    },
    f.sourceAdmission
  )
  const owner = { ...f.state.sshPtyConsumerRecoveries![0], clientGeneration: 2, ownerGeneration: 2 }
  f.state.sshPtyConsumerRecoveries = [owner]
  f.state.sshRemotePtyLeases = f.state.sshRemotePtyLeases!.map((lease) => ({
    ...lease,
    state: 'detached',
    updatedAt: 2,
    lastDetachedAt: 2
  }))
  // Native exclusion and authenticated cancellation are modeled; projection uses current evidence.
  const admission = {
    owner,
    assertCurrent: vi.fn<() => void>(),
    assertCancellation: vi.fn<(record: unknown) => void>(),
    assertBindings: vi.fn<(bindings: unknown) => void>((bindings) =>
      expect(bindings).toEqual(f.cutover.liveTerminalBindings)
    ),
    projectSourceState: (
      state: Parameters<typeof projectOrcadSourceLiveState>[0],
      source: Parameters<typeof projectOrcadSourceLiveState>[1],
      catalog: Parameters<typeof projectOrcadSourceLiveState>[2]
    ) =>
      projectOrcadSourceLiveState(state, source, catalog, {
        bindings: f.cutover.liveTerminalBindings!,
        leases: f.state.sshRemotePtyLeases!,
        recovery: owner
      })
  }
  const install = (installedAt = f.cutover.updatedAt) =>
    domain.installOrcadLiveSuccessorRetirementProfile(record, admission, installedAt)
  return { ...f, record, domain, publication, admission, install, schedulingRuntime }
}

it('installs the typed successor candidate and durable publication with newer owner and client generations', () => {
  const f = fixture()
  const marker = f.install()
  expect(marker.recordSha256).toBe(f.record.sha256)
  expect(f.domain.inspectOrcadLiveRetirementProfileState(f.record).state).toBe('profile-installed')
  expect(f.state.sshPtyConsumerRecoveries).toEqual([])
  expect(f.state.sshRemotePtyLeases).toEqual([])
  expect(new OrcadRetirementSessionPublication(directory).installedRecords(f.state)).toEqual([
    f.record
  ])
  expect(f.schedulingRuntime.writeGeneration).toBeGreaterThan(0)
  expect(f.admission.assertCancellation).toHaveBeenCalledWith(f.record)
})

it.each(['native', 'cancellation'] as const)('refuses %s authority loss without writes', (kind) => {
  const f = fixture()
  const before = structuredClone(f.state)
  const record = vi.spyOn(f.publication, 'record')
  const assertion = kind === 'native' ? f.admission.assertCurrent : f.admission.assertCancellation
  assertion.mockImplementation(() => {
    throw new Error('authority-lost')
  })
  expect(() => f.install()).toThrow('authority-lost')
  expect(f.state).toEqual(before)
  expect(record).not.toHaveBeenCalled()
  expect(f.schedulingRuntime.writeGeneration).toBe(0)
})

it('rejects state mutation inside cancellation assertion without installing candidate or publishing', () => {
  const f = fixture()
  const record = vi.spyOn(f.publication, 'record')
  f.admission.assertCancellation.mockImplementationOnce(() => {
    f.state.sshTargets![0].label = 'changed'
  })
  expect(() => f.install()).toThrow()
  expect(f.state.orcadLiveRetirementMarkers ?? []).toEqual([])
  expect(record).not.toHaveBeenCalled()
  expect(f.schedulingRuntime.writeGeneration).toBe(0)
})

it('keeps ordinary installation strict for newer owner state', () => {
  const f = fixture()
  const before = structuredClone(f.state)
  expect(() =>
    f.domain.installOrcadLiveRetirementProfile(f.record, f.admission, f.cutover.updatedAt)
  ).toThrow('not_prepared')
  expect(f.state).toEqual(before)
  expect(f.schedulingRuntime.writeGeneration).toBe(0)
})

it('rejects mutation in the final cancellation recheck after candidate validation', () => {
  const f = fixture()
  const record = vi.spyOn(f.publication, 'record')
  f.admission.assertCancellation
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      f.state.sshTargets![0].label = 'changed-after-candidate'
    })
  expect(() => f.install()).toThrow('successor_profile_state_changed')
  expect(f.state.orcadLiveRetirementMarkers ?? []).toEqual([])
  expect(record).not.toHaveBeenCalled()
  expect(f.schedulingRuntime.writeGeneration).toBe(0)
})

it.each(['marker', 'journal'] as const)('rejects %s conflict without mutation', (kind) => {
  const f = fixture()
  if (kind === 'marker') {
    f.state.orcadLiveRetirementMarkers = [
      {
        version: 1,
        migrationId: f.cutover.manifest.migrationId,
        recordSha256: 'f'.repeat(64),
        installedAt: f.cutover.updatedAt
      }
    ]
  } else {
    f.state.orcadMigrationSourceCutovers = []
  }
  const before = structuredClone(f.state)
  const record = vi.spyOn(f.publication, 'record')
  expect(() => f.install()).toThrow()
  expect(f.state).toEqual(before)
  expect(record).not.toHaveBeenCalled()
  expect(f.schedulingRuntime.writeGeneration).toBe(0)
})

it('validates installedAt before publication or state mutation', () => {
  const f = fixture()
  const before = structuredClone(f.state)
  const record = vi.spyOn(f.publication, 'record')
  expect(() => f.install('invalid')).toThrow()
  expect(f.state).toEqual(before)
  expect(record).not.toHaveBeenCalled()
  expect(f.schedulingRuntime.writeGeneration).toBe(0)
})
