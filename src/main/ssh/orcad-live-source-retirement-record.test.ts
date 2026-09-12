import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as secure from '../../shared/secure-file'
import {
  createOrcadLiveSourceCleanupIntent,
  OrcadLiveSourceCleanupIntentStore,
  parseOrcadLiveSourceCleanupIntent
} from './orcad-live-source-cleanup-intent'
import { inspectOrcadLiveRetirementRecovery } from './orcad-live-retirement-recovery-inspection'
import { liveSourceRetirementFixture } from '../persistence/migrating-orcad-catalog/orcad-live-source-retirement-test-fixture'
import {
  collectOrcadLiveRetirementProfileChanges,
  inspectOrcadLiveRetirementProfileChanges,
  parseOrcadLiveRetirementProfileChanges
} from '../persistence/migrating-orcad-catalog/orcad-live-retirement-profile-changes'
import {
  createOrcadLiveSourceRetirementRecord,
  parseOrcadLiveSourceRetirementRecord,
  OrcadLiveSourceRetirementRecordStore
} from './orcad-live-source-retirement-record'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-retirement-record-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const f = liveSourceRetirementFixture()
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
  const create = () => createOrcadLiveSourceRetirementRecord({ ...f, release })
  return { ...f, release, create, store: new OrcadLiveSourceRetirementRecordStore(root) }
}

it('persists cleanup intent as a reference to exact retirement evidence, not completed retirement', () => {
  const f = fixture()
  const record = f.create()
  const intent = createOrcadLiveSourceCleanupIntent(record)
  const before = structuredClone(f.state)
  const cleanup = new OrcadLiveSourceCleanupIntentStore(root)
  expect(cleanup.persist(intent)).toEqual(intent)
  expect(new OrcadLiveSourceCleanupIntentStore(root).list()).toEqual([intent])
  expect(intent).toMatchObject({ phase: 'cleanup-prepared', retirementRecordSha256: record.sha256 })
  expect(f.state).toEqual(before)
  expect(() => parseOrcadLiveSourceCleanupIntent({ ...intent, phase: 'source-retired' })).toThrow()
  expect(() => cleanup.persist({ ...intent, retirementRecordSha256: 'a'.repeat(64) })).toThrow(
    'conflict'
  )
})

it('reflushes a readable cleanup intent after an uncertain write', () => {
  const f = fixture()
  const intent = createOrcadLiveSourceCleanupIntent(f.create())
  const cleanup = new OrcadLiveSourceCleanupIntentStore(root)
  const original = secure.writeDurableSecureJsonFile
  const write = vi.spyOn(secure, 'writeDurableSecureJsonFile').mockImplementationOnce((...args) => {
    original(...args)
    throw new Error('cleanup flush uncertain')
  })
  expect(() => cleanup.persist(intent)).toThrow('cleanup flush uncertain')
  expect(cleanup.read(intent.identity)).toEqual(intent)
  expect(cleanup.persist(intent)).toEqual(intent)
  expect(write).toHaveBeenCalledTimes(2)
})

it('refuses orphan cleanup intent discovery and joins it only to the exact immutable record', () => {
  const f = fixture()
  const record = f.create()
  new OrcadLiveSourceCleanupIntentStore(root).persist(createOrcadLiveSourceCleanupIntent(record))
  const inspect = vi.fn(() => ({ state: 'prepared' as const, record }))
  const store = {
    listOrcadLiveRetirementMarkers: () => [],
    inspectOrcadLiveRetirementProfileState: inspect
  }
  expect(() => inspectOrcadLiveRetirementRecovery(root, store)).toThrow(
    'cleanup_recovery_record_conflict'
  )
  expect(inspect).not.toHaveBeenCalled()
  f.store.persist(record)
  expect(inspectOrcadLiveRetirementRecovery(root, store)).toEqual([
    { state: 'prepared', record, cleanupPrepared: true }
  ])
})

it('durably retains exact scoped before/after evidence without installing the candidate', () => {
  const f = fixture()
  const before = structuredClone(f.state)
  const record = f.create()
  expect(inspectOrcadLiveRetirementProfileChanges(f.state, record.changes)).toBe('before')
  expect(inspectOrcadLiveRetirementProfileChanges(f.run(), record.changes)).toBe('after')
  expect(record.changes.map((entry) => entry.field)).not.toContain('settings')
  expect(record.changes.map((entry) => entry.field)).not.toContain('sshTargets')
  expect(f.store.persist(record)).toEqual(record)
  expect(new OrcadLiveSourceRetirementRecordStore(root).read(record.identity)).toEqual(record)
  expect(f.store.list()).toEqual([record])
  expect(f.state).toEqual(before)
  if (process.platform !== 'win32') {
    const directory = join(root, 'orcad-live-source-retirement-records')
    expect(statSync(join(directory, readdirSync(directory)[0])).mode & 0o777).toBe(0o600)
  }
})

it('ignores untouched slices but classifies mixed or newly edited touched slices as conflicts', () => {
  const f = fixture()
  const record = f.create()
  f.state.sshTargets.push({ ...f.state.sshTargets[0], id: 'unrelated' })
  expect(inspectOrcadLiveRetirementProfileChanges(f.state, record.changes)).toBe('before')
  const mixed = structuredClone(f.state)
  mixed.sshRemotePtyLeases = []
  expect(inspectOrcadLiveRetirementProfileChanges(mixed, record.changes)).toBe('conflict')
  const after = f.run()
  after.repos.push({ ...f.state.repos[0], id: 'new-repo', connectionId: 'other-host' })
  expect(inspectOrcadLiveRetirementProfileChanges(after, record.changes)).toBe('conflict')
})

it('refuses candidate changes outside the retirement allowlist', () => {
  const f = fixture()
  const candidate = f.run()
  candidate.sshTargets[0].label = 'Changed'
  expect(() => collectOrcadLiveRetirementProfileChanges(f.state, candidate)).toThrow(
    'scope_changed'
  )
})

it.each(['digest', 'identity', 'duplicate', 'scope', 'missing-authority', 'noncanonical'] as const)(
  'rejects malformed %s retirement evidence',
  (change) => {
    const record = fixture().create()
    if (change === 'digest') {
      record.sha256 = '0'.repeat(64)
    }
    if (change === 'identity') {
      Object.assign(record.identity, { bridgeId: 'other' })
    }
    if (change === 'duplicate') {
      record.changes.push(record.changes[0])
    }
    if (change === 'scope') {
      Object.assign(record.changes[0], { field: 'settings' })
    }
    if (change === 'missing-authority') {
      record.changes = record.changes.filter((entry) => entry.field !== 'sshRemotePtyLeases')
    }
    if (change === 'noncanonical') {
      record.changes[0].before = ' [ ] '
    }
    expect(() => parseOrcadLiveSourceRetirementRecord(record)).toThrow()
  }
)

it('preserves absent fields distinctly from explicit JSON null', () => {
  const changes = parseOrcadLiveRetirementProfileChanges([
    { field: 'sshRemotePtyLeases', before: '[1]', after: '[]' },
    { field: 'sshPtyConsumerRecoveries', before: '[1]', after: '[]' },
    { field: 'workspaceSessionsByHostId', before: null, after: 'null' }
  ])
  expect(changes.find((entry) => entry.field === 'workspaceSessionsByHostId')).toEqual({
    field: 'workspaceSessionsByHostId',
    before: null,
    after: 'null'
  })
})

it('reflushes exact retries and refuses conflicting observations under the same identity', () => {
  const f = fixture()
  const record = f.create()
  const write = vi.spyOn(secure, 'writeDurableSecureJsonFile')
  f.store.persist(record)
  f.store.persist(record)
  expect(write).toHaveBeenCalledTimes(2)
  f.release.activations[0].destinationClaim = { generation: 2, claimId: 'new-claim' }
  expect(() => f.store.persist(f.create())).toThrow('conflict')
})

it('does not acknowledge an uncertain durable write merely because the record is readable', () => {
  const f = fixture()
  const record = f.create()
  const original = secure.writeDurableSecureJsonFile
  const write = vi.spyOn(secure, 'writeDurableSecureJsonFile').mockImplementationOnce((...args) => {
    original(...args)
    throw new Error('flush uncertain')
  })
  expect(() => f.store.persist(record)).toThrow('flush uncertain')
  expect(f.store.read(record.identity)).toEqual(record)
  expect(f.store.persist(record)).toEqual(record)
  expect(write).toHaveBeenCalledTimes(2)
})

it('refuses corrupt discovered evidence instead of reporting no pending retirement', () => {
  const f = fixture()
  f.store.persist(f.create())
  const directory = join(root, 'orcad-live-source-retirement-records')
  writeFileSync(join(directory, readdirSync(directory)[0]), '{}')
  expect(() => f.store.list()).toThrow()
})
