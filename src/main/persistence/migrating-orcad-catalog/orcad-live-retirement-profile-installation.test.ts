import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { liveSourceRetirementFixture } from './orcad-live-source-retirement-test-fixture'
import { OrcadSourceRetirementPersistence } from './orcad-source-retirement-persistence'
import { WriteSchedulingOperations } from '../loading-store/write-scheduling'
import { createOrcadLiveCompletedCutover } from '../../ssh/orcad-live-completed-cutover'
import { listOrcadLiveRetirementProfileDrift } from './orcad-live-retirement-profile-changes'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcadRetirementSessionPublication } from '../loading-store/orcad-retirement-session-publication'
import { OrcadLiveSourceRetirementRecordStore } from '../../ssh/orcad-live-source-retirement-record'

const directories: string[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(mirrorLocal = false) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-retirement-publication-'))
  directories.push(directory)
  const publication = new OrcadRetirementSessionPublication(directory)
  const f = liveSourceRetirementFixture('folder', 'ssh-1', mirrorLocal)
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
  const release = {
    version: 1,
    cutover: f.cutover,
    activations: f.cutover.terminalPublications!.map((publication) => ({
      version: 1,
      identity: publication.identity,
      publicationReceipt: publication.publicationReceipt,
      destinationClaim: { generation: 1, claimId: 'claim' },
      catalog: publication.catalog
    }))
  }
  const record = domain.createOrcadLiveSourceRetirementRecord(release, f.sourceAdmission)
  const install = () =>
    domain.installOrcadLiveRetirementProfile(record, f.sourceAdmission, f.cutover.updatedAt)
  return { ...f, domain, record, install, schedulingRuntime, publication, directory }
}

it('requires an installed marker before durable evidence authorizes session publication', () => {
  const f = fixture()
  f.publication.record(f.record)
  expect(f.publication.installedRecords(f.state)).toEqual([])
  f.install()
  expect(new OrcadRetirementSessionPublication(f.directory).installedRecords(f.state)).toEqual([
    f.record
  ])
})

it('refuses installed markers without matching durable session evidence', () => {
  const f = fixture()
  f.install()
  const emptyDirectory = mkdtempSync(join(tmpdir(), 'orca-retirement-publication-'))
  directories.push(emptyDirectory)
  expect(() =>
    new OrcadRetirementSessionPublication(emptyDirectory).installedRecords(f.state)
  ).toThrow('orcad_retirement_session_publication_evidence_invalid')
  f.state.orcadLiveRetirementMarkers![0].recordSha256 = 'f'.repeat(64)
  expect(() => f.publication.installedRecords(f.state)).toThrow(
    'orcad_retirement_session_publication_evidence_invalid'
  )
})

it('does not install state or marker if the profile-local evidence write fails', () => {
  const f = fixture()
  const before = structuredClone(f.state)
  vi.spyOn(f.publication, 'record').mockImplementation(() => {
    throw new Error('disk-unavailable')
  })
  expect(f.install).toThrow('disk-unavailable')
  expect(f.state).toEqual(before)
  expect(f.schedulingRuntime.writeGeneration).toBe(0)
})

it('propagates malformed durable evidence instead of returning an empty installed set', () => {
  const f = fixture()
  f.install()
  vi.spyOn(OrcadLiveSourceRetirementRecordStore.prototype, 'list').mockImplementationOnce(() => {
    throw new Error('orcad_live_source_retirement_record_invalid')
  })
  expect(() =>
    new OrcadRetirementSessionPublication(f.directory).installedRecords(f.state)
  ).toThrow('orcad_live_source_retirement_record_invalid')
})

function completion(f: ReturnType<typeof fixture>) {
  const completionEvidence = {
    version: 1,
    retirementRecordSha256: f.record.sha256,
    sourceRouteCheckpointSha256: 'b'.repeat(64)
  }
  return {
    candidate: createOrcadLiveCompletedCutover({
      committed: f.cutover,
      completionEvidence,
      retiredAt: '2026-09-07T12:00:00.000Z'
    }),
    admission: { completionEvidence, assertCurrent: vi.fn() }
  }
}

it('completes only the exact installed journal and preserves the original retry timestamp', () => {
  const f = fixture()
  f.install()
  const { candidate, admission } = completion(f)
  const before = structuredClone(f.state)
  expect(f.domain.completeOrcadLiveRetirementProfile(f.record, candidate, admission)).toEqual(
    candidate
  )
  expect(f.state).toEqual({ ...before, orcadMigrationSourceCutovers: [candidate] })
  expect(f.domain.inspectOrcadLiveRetirementProfileState(f.record)).toMatchObject({
    state: 'profile-installed',
    completedCutover: candidate
  })
  expect(f.domain.completeOrcadLiveRetirementProfile(f.record, candidate, admission)).toEqual(
    candidate
  )
  const later = {
    ...candidate,
    retiredAt: '2026-09-08T12:00:00.000Z',
    updatedAt: '2026-09-08T12:00:00.000Z'
  }
  expect(() => f.domain.completeOrcadLiveRetirementProfile(f.record, later, admission)).toThrow(
    'candidate_changed'
  )
  expect(f.state.orcadMigrationSourceCutovers).toEqual([candidate])
})

it('does not complete an uninstalled profile', () => {
  const f = fixture()
  const { candidate, admission } = completion(f)
  expect(() => f.domain.completeOrcadLiveRetirementProfile(f.record, candidate, admission)).toThrow(
    'not_installed'
  )
  expect(admission.assertCurrent).not.toHaveBeenCalled()
})

it('keeps completed publication evidence usable after unrelated folder catalog edits', () => {
  const f = fixture()
  f.install()
  const { candidate, admission } = completion(f)
  f.domain.completeOrcadLiveRetirementProfile(f.record, candidate, admission)
  f.state.folderWorkspaces.push({
    ...f.cutover.manifest.payload.folderWorkspaces[0],
    id: 'unrelated-folder',
    connectionId: null
  })
  expect(new OrcadRetirementSessionPublication(f.directory).installedRecords(f.state)).toEqual([
    f.record
  ])
  expect(() => f.domain.completeOrcadLiveRetirementProfile(f.record, candidate, admission)).toThrow(
    'not_installed'
  )
})

it('rechecks profile changes after the authority callback without overwriting them', () => {
  const f = fixture()
  f.install()
  const { candidate, admission } = completion(f)
  admission.assertCurrent.mockImplementation(() => {
    f.state.repos = f.cutover.manifest.payload.repositories.map((repo) => ({
      ...repo,
      connectionId: f.cutover.manifest.source.sshTargetId
    }))
  })
  expect(() => f.domain.completeOrcadLiveRetirementProfile(f.record, candidate, admission)).toThrow(
    'not_installed'
  )
  expect(f.state.repos).toHaveLength(1)
  expect(f.state.orcadMigrationSourceCutovers).toEqual([f.cutover])
})

it('refuses a completion admission for a different retirement record', () => {
  const f = fixture()
  f.install()
  const { admission } = completion(f)
  admission.completionEvidence.retirementRecordSha256 = 'c'.repeat(64)
  const candidate = createOrcadLiveCompletedCutover({
    committed: f.cutover,
    completionEvidence: admission.completionEvidence,
    retiredAt: '2026-09-07T12:00:00.000Z'
  })
  expect(() => f.domain.completeOrcadLiveRetirementProfile(f.record, candidate, admission)).toThrow(
    'candidate_changed'
  )
  expect(f.state.orcadMigrationSourceCutovers).toEqual([f.cutover])
})

it('refuses a candidate restamped during the authority callback', () => {
  const f = fixture()
  f.install()
  const { candidate, admission } = completion(f)
  admission.assertCurrent.mockImplementation(() => {
    candidate.updatedAt = '2026-09-08T12:00:00.000Z'
    candidate.retiredAt = candidate.updatedAt
  })
  expect(() => f.domain.completeOrcadLiveRetirementProfile(f.record, candidate, admission)).toThrow(
    'candidate_changed'
  )
  expect(f.state.orcadMigrationSourceCutovers).toEqual([f.cutover])
})

it('installs validated scoped changes and marker together while preserving the source fence and journal', () => {
  const f = fixture()
  const before = structuredClone(f.state)
  expect(f.domain.inspectOrcadLiveRetirementProfileState(f.record).state).toBe('prepared')
  const marker = f.install()
  expect(f.state.sshRemotePtyLeases).toEqual([])
  expect(f.state.sshPtyConsumerRecoveries).toEqual([])
  expect(f.state.repos).toEqual([])
  expect(f.state.orcadLiveRetirementMarkers).toEqual([marker])
  expect(marker.recordSha256).toBe(f.record.sha256)
  expect(f.state.sshTargets).toEqual(before.sshTargets)
  expect(f.state.orcadMigrationSourceCutovers).toEqual(before.orcadMigrationSourceCutovers)
  expect(f.state.settings).toEqual(before.settings)
  expect(f.schedulingRuntime.writeGeneration).toBe(1)
  expect(f.domain.inspectOrcadLiveRetirementProfileState(f.record).state).toBe('profile-installed')
  expect(() => f.install()).toThrow('profile_not_prepared')
  expect(f.schedulingRuntime.writeGeneration).toBe(1)
})

it('preserves later changes outside the scoped retirement slices', () => {
  const f = fixture()
  f.state.sshTargets.push({ ...f.state.sshTargets[0], id: 'other-host' })
  f.install()
  expect(f.state.sshTargets).toHaveLength(2)
})

it.each(['lease', 'journal', 'marker', 'authority', 'slice'] as const)(
  'refuses changed %s evidence before installing any profile slice',
  (change) => {
    const f = fixture()
    if (change === 'lease') {
      f.state.sshRemotePtyLeases[0].updatedAt++
    }
    if (change === 'journal') {
      f.state.orcadMigrationSourceCutovers = []
    }
    if (change === 'marker') {
      f.state.orcadLiveRetirementMarkers = [
        {
          version: 1,
          migrationId: f.cutover.manifest.migrationId,
          recordSha256: '0'.repeat(64),
          installedAt: f.cutover.updatedAt
        }
      ]
    }
    if (change === 'authority') {
      f.sourceAdmission.assertCurrent.mockImplementation(() => {
        throw new Error('authority lost')
      })
    }
    if (change === 'slice') {
      f.state.repos.push({ ...f.state.repos[0], id: 'other', connectionId: 'other' })
    }
    const before = structuredClone(f.state)
    expect(f.install).toThrow()
    expect(f.state).toEqual(before)
    expect(f.schedulingRuntime.writeGeneration).toBe(0)
  }
)

it('rejects a malformed installation timestamp without partial profile mutation', () => {
  const f = fixture()
  const before = structuredClone(f.state)
  expect(() =>
    f.domain.installOrcadLiveRetirementProfile(f.record, f.sourceAdmission, 'invalid')
  ).toThrow('marker_invalid')
  expect(f.state).toEqual(before)
  expect(f.schedulingRuntime.writeGeneration).toBe(0)
})

it('requires matching marker and complete after-state, never just one of them', () => {
  const f = fixture()
  f.install()
  const markers = f.state.orcadLiveRetirementMarkers
  delete f.state.orcadLiveRetirementMarkers
  expect(f.domain.inspectOrcadLiveRetirementProfileState(f.record)).toMatchObject({
    state: 'conflict',
    diagnostic: { reason: 'marker-or-fields', markerMatches: false, fields: [] }
  })
  f.state.orcadLiveRetirementMarkers = markers
  f.state.repos = structuredClone(f.cutover.manifest.payload.repositories)
  expect(f.domain.inspectOrcadLiveRetirementProfileState(f.record)).toMatchObject({
    state: 'conflict',
    diagnostic: { reason: 'marker-or-fields', markerMatches: true, fields: ['repos'] }
  })
})

it('reports local session drift using schema field names without values', () => {
  const f = fixture()
  f.install()
  const changes = [
    ...f.record.changes,
    {
      field: 'workspaceSession',
      before: serializeOrcadMigrationValue({
        ...f.state.workspaceSession,
        activeTabId: 'source-tab'
      }),
      after: serializeOrcadMigrationValue(f.state.workspaceSession)
    }
  ]
  f.state.workspaceSession.activeTabId = 'private-tab-value'
  expect(listOrcadLiveRetirementProfileDrift(f.state, changes)).toEqual([
    'workspaceSession.activeTabId'
  ])
})

it('detects stale mirrored renderer fields after retirement without rewriting either snapshot', () => {
  const f = fixture(true)
  const previous = structuredClone(f.state.workspaceSession)
  f.install()
  expect(f.domain.inspectOrcadLiveRetirementProfileState(f.record).state).toBe('profile-installed')
  Object.assign(f.state.workspaceSession, {
    activeConnectionIdsAtShutdown: previous.activeConnectionIdsAtShutdown,
    terminalLayoutsByTabId: previous.terminalLayoutsByTabId
  })
  const replayed = structuredClone(f.state.workspaceSession)
  expect(f.domain.inspectOrcadLiveRetirementProfileState(f.record)).toMatchObject({
    state: 'conflict',
    diagnostic: {
      fields: [
        'workspaceSession.activeConnectionIdsAtShutdown',
        'workspaceSession.terminalLayoutsByTabId'
      ]
    }
  })
  expect(f.state.workspaceSession).toEqual(replayed)
})

it('preserves installed proof when only unrelated browser history changes', () => {
  const f = fixture(true)
  f.install()
  f.state.workspaceSession.browserUrlHistory = [
    {
      url: 'https://unrelated.example/',
      normalizedUrl: 'https://unrelated.example/',
      title: 'Unrelated work',
      lastVisitedAt: 1,
      visitCount: 1
    }
  ]
  const newer = structuredClone(f.state.workspaceSession)
  expect(f.domain.inspectOrcadLiveRetirementProfileState(f.record)).toMatchObject({
    state: 'profile-installed'
  })
  expect(f.state.workspaceSession).toEqual(newer)
})
