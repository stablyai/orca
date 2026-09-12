import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as secure from '../../shared/secure-file'
import { liveSourceRetirementFixture } from '../persistence/migrating-orcad-catalog/orcad-live-source-retirement-test-fixture'
import { OrcadSourceCutoverPersistence } from '../persistence/migrating-orcad-catalog/orcad-source-cutover'
import { OrcadSourceRetirementPersistence } from '../persistence/migrating-orcad-catalog/orcad-source-retirement-persistence'
import { collectOrcadMigrationSourceDependencyCensus } from '../persistence/migrating-orcad-catalog/orcad-source-dependency-census'
import { OrcadLiveSourceRetirementRecordStore } from './orcad-live-source-retirement-record'
import { OrcadLiveSourceReleaseIntentStore } from './orcad-live-source-release-intent'
import { prepareOrcadLiveSourceRetirementUnderAuthority } from './orcad-live-source-retirement-preparation'
import { prepareOrcadLiveSourceReleaseUnderAuthority } from './orcad-live-source-release-preparation'
import { OrcadRetirementSessionPublication } from '../persistence/loading-store/orcad-retirement-session-publication'

const commit = vi.hoisted(() => vi.fn())
vi.mock('./orcad-live-destination-commit', () => ({ commitOrcadLiveDestination: commit }))
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-retirement-preparation-'))
  commit.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const f = liveSourceRetirementFixture()
  type DomainArguments = ConstructorParameters<typeof OrcadSourceCutoverPersistence>
  const domain = new OrcadSourceCutoverPersistence(
    { state: f.state, terminalScrollbackSnapshotStorage: {} },
    {} as DomainArguments[1],
    {} as DomainArguments[2],
    {} as DomainArguments[3]
  )
  const controller = new AbortController()
  const retirement = new OrcadSourceRetirementPersistence(
    {
      state: f.state,
      terminalScrollbackSnapshotStorage: {},
      orcadRetirementSessionPublication: new OrcadRetirementSessionPublication(root)
    },
    {} as DomainArguments[3]
  )
  const assertAuthority = vi.fn()
  let generation = 1
  commit.mockResolvedValue(f.cutover)
  const activate = vi.fn(async ({ request }) => ({
    version: 1,
    identity: request.identity,
    publicationReceipt: request.publicationReceipt,
    destinationClaim: { generation, claimId: `claim-${generation}` },
    catalog: {
      migrationId: f.cutover.manifest.migrationId,
      manifestSha256: f.cutover.manifest.manifestSha256
    }
  }))
  const options = {
    profileDirectory: root,
    pairingCode: 'paired',
    cutover: f.cutover,
    signal: controller.signal,
    assertAuthority,
    activate,
    sourceAdmission: f.sourceAdmission,
    store: {
      getOrcadMigrationSourceCutover: domain.getOrcadMigrationSourceCutover.bind(domain),
      createOrcadLiveSourceRetirementRecord:
        retirement.createOrcadLiveSourceRetirementRecord.bind(retirement),
      inspectOrcadMigrationSourceDependencies: () =>
        collectOrcadMigrationSourceDependencyCensus(
          f.sourceAdmission.projectSourceState(
            f.state,
            f.cutover.manifest.source,
            f.cutover.manifest.payload
          ),
          f.cutover.manifest
        )
    }
  }
  const run = () =>
    prepareOrcadLiveSourceRetirementUnderAuthority(
      options as unknown as Parameters<typeof prepareOrcadLiveSourceRetirementUnderAuthority>[0]
    )
  const releaseOnly = () =>
    prepareOrcadLiveSourceReleaseUnderAuthority(
      options as unknown as Parameters<typeof prepareOrcadLiveSourceReleaseUnderAuthority>[0]
    )
  return {
    ...f,
    options,
    run,
    releaseOnly,
    activate,
    assertAuthority,
    controller,
    setGeneration: (next: number) => {
      generation = next
    }
  }
}

it('joins fresh activation, release intent and actual persistence-domain candidate preparation without retiring state', async () => {
  const f = fixture()
  const before = structuredClone(f.state)
  const result = await f.run()
  expect(commit).toHaveBeenCalledOnce()
  expect(f.activate).toHaveBeenCalledTimes(2)
  expect(new OrcadLiveSourceReleaseIntentStore(root).list()).toHaveLength(1)
  expect(new OrcadLiveSourceRetirementRecordStore(root).list()).toEqual([result.record])
  expect(result.record.release.activations).toEqual(result.activations)
  expect(f.state).toEqual(before)
})

it('revalidates and reflushes exact retries while keeping the first retirement record immutable', async () => {
  const f = fixture()
  const first = await f.run()
  const write = vi.spyOn(secure, 'writeDurableSecureJsonFile')
  f.setGeneration(2)
  const second = await f.run()
  expect(second.record).toEqual(first.record)
  expect(second.activations.every((entry) => entry.destinationClaim.generation === 2)).toBe(true)
  expect(f.activate).toHaveBeenCalledTimes(4)
  expect(write).toHaveBeenCalledTimes(2)
})

it('checks the retirement record claim floor, not just the earlier release intent floor', async () => {
  const f = fixture()
  await f.releaseOnly()
  f.setGeneration(3)
  const first = await f.run()
  const releaseStore = new OrcadLiveSourceReleaseIntentStore(root)
  expect(releaseStore.read(first.record.identity)?.activations[0].destinationClaim.generation).toBe(
    1
  )
  expect(first.record.release.activations[0].destinationClaim.generation).toBe(3)
  f.setGeneration(2)
  await expect(f.run()).rejects.toThrow('release_activation_regressed')
  expect(new OrcadLiveSourceRetirementRecordStore(root).list()).toEqual([first.record])
})

it('refuses a changed touched profile slice rather than replacing the saved rollback record', async () => {
  const f = fixture()
  const first = await f.run()
  f.state.repos.push({ ...f.state.repos[0], id: 'other-repo', connectionId: 'other-host' })
  await expect(f.run()).rejects.toThrow('retirement_record_conflict')
  expect(new OrcadLiveSourceRetirementRecordStore(root).list()).toEqual([first.record])
  expect(f.state.repos).toHaveLength(2)
})

it('refuses source changes during the retirement write without acknowledging preparation', async () => {
  const f = fixture()
  const original = secure.writeDurableSecureJsonFile
  vi.spyOn(secure, 'writeDurableSecureJsonFile').mockImplementation((path, value) => {
    const result = original(path, value)
    if (String(path).includes('orcad-live-source-retirement-records')) {
      f.state.sshRemotePtyLeases[0].updatedAt++
    }
    return result
  })
  await expect(f.run()).rejects.toThrow('live_evidence_changed')
  expect(new OrcadLiveSourceRetirementRecordStore(root).list()).toHaveLength(1)
  expect(f.state.sshRemotePtyLeases).toHaveLength(2)
  expect(f.state.orcadMigrationSourceCutovers?.[0].phase).toBe('destination-committed')
})

it('does not persist retirement evidence when fresh activation becomes unavailable', async () => {
  const f = fixture()
  f.activate.mockRejectedValueOnce(new Error('destination unavailable'))
  await expect(f.run()).rejects.toThrow('destination unavailable')
  expect(new OrcadLiveSourceRetirementRecordStore(root).list()).toEqual([])
  expect(f.state.sshRemotePtyLeases).toHaveLength(2)
})

it('rechecks touched slices after persistence even when the source dependency census is unchanged', async () => {
  const f = fixture()
  const original = secure.writeDurableSecureJsonFile
  vi.spyOn(secure, 'writeDurableSecureJsonFile').mockImplementation((path, value) => {
    const result = original(path, value)
    if (String(path).includes('orcad-live-source-retirement-records')) {
      f.state.repos.push({ ...f.state.repos[0], id: 'other-repo', connectionId: 'other-host' })
    }
    return result
  })
  await expect(f.run()).rejects.toThrow('retirement_record_conflict')
  expect(new OrcadLiveSourceRetirementRecordStore(root).list()).toHaveLength(1)
  expect(f.state.repos).toHaveLength(2)
  expect(f.state.sshRemotePtyLeases).toHaveLength(2)
})

it('retries an uncertain retirement-record write through fresh activation and acknowledged reflush', async () => {
  const f = fixture()
  const original = secure.writeDurableSecureJsonFile
  let fail = true
  vi.spyOn(secure, 'writeDurableSecureJsonFile').mockImplementation((path, value) => {
    const result = original(path, value)
    if (fail && String(path).includes('orcad-live-source-retirement-records')) {
      fail = false
      throw new Error('write uncertain')
    }
    return result
  })
  await expect(f.run()).rejects.toThrow('write uncertain')
  expect(new OrcadLiveSourceRetirementRecordStore(root).list()).toHaveLength(1)
  const result = await f.run()
  expect(f.activate).toHaveBeenCalledTimes(4)
  expect(new OrcadLiveSourceRetirementRecordStore(root).list()).toEqual([result.record])
})
