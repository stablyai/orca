import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createStore, testState, readDataFile, writeDataFile } from '../persistence-test-harness'
import type { PersistedState } from '../../shared/persisted-state-types'
import {
  setupSource,
  DORMANT_LEAF_ID,
  receipt,
  TARGET
} from '../orcad-migration-source-cutover-test-fixture'
import { parseOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { OrcadLiveCutoverIntentStore } from './orcad-live-cutover-intent-store'
import { recordOrcadLiveCutoverProgressDurably } from './orcad-live-cutover-progress'
import { publishOrcadLiveTerminals } from './orcad-live-terminal-publication'
import { commitOrcadLiveDestination } from './orcad-live-destination-commit'
import { migrateOrcadLiveDestination } from './orcad-live-destination-coordinator'
import { createOrcadMigrationManifest } from './orcad-migration-manifest-export'

const terminals = vi.hoisted(() => ({ create: vi.fn(), prepare: vi.fn() }))
vi.mock('./orcad-outgoing-preparation-creation', () => ({
  createOutgoingOrcadCatalogPreparationUnderAuthority: terminals.create
}))
vi.mock('./orcad-outgoing-terminal-preparation', () => ({
  prepareOutgoingOrcadTerminalUnderAuthority: terminals.prepare
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-live-progress-'))
  terminals.create.mockReset()
  terminals.prepare.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

async function fixture(terminalCount = 1, buffer?: string) {
  const { store } = setupSource({ dormantSession: true })
  const session = store.getWorkspaceSession(`ssh:${TARGET.id}`)
  const tabs = session.tabsByWorktree['repo-1::/srv/repo-1-worktree']
  if (buffer !== undefined) {
    session.terminalLayoutsByTabId['tab-dormant'].buffersByLeafId = { [DORMANT_LEAF_ID]: buffer }
  }
  for (let index = 1; index < terminalCount; index++) {
    const tabId = `tab-dormant-${index}`
    tabs.push({ ...tabs[0], id: tabId })
    session.terminalLayoutsByTabId[tabId] = structuredClone(
      session.terminalLayoutsByTabId['tab-dormant']
    )
  }
  store.setWorkspaceSession(session, `ssh:${TARGET.id}`)
  const manifest = createOrcadMigrationManifest(store, TARGET, {
    migrationId: 'migration-1',
    now: () => new Date('2026-08-30T12:00:00.000Z')
  })
  const legacy = store.beginOrcadMigrationSourceCutover(manifest, 'environment-1')
  await store.flushPendingOrThrowAsync()
  const initial = parseOrcadMigrationSourceCutover({
    ...legacy,
    version: 2,
    liveTerminalBindings: Array.from({ length: terminalCount }, (_, index) => ({
      identity: {
        bridgeId: `bridge-${index}`,
        terminalId: `terminal-${index}`,
        incarnationId: `incarnation-${index}`,
        ownerLease: 'owner',
        sourceOwnerGeneration: 1,
        destinationRuntimeId: 'runtime'
      },
      surfaceBinding: {
        executionHostId: 'local',
        workspaceKey: 'worktree:repo-1::/srv/repo-1-worktree',
        tabId: index === 0 ? 'tab-dormant' : `tab-dormant-${index}`,
        leafId: DORMANT_LEAF_ID,
        ptyId: `terminal-${index}`
      }
    }))
  })
  new OrcadLiveCutoverIntentStore(testState.dir).persist(initial)
  const disk = readDataFile() as PersistedState
  disk.orcadMigrationSourceCutovers = [initial]
  writeDataFile(disk)
  const restored = createStore()
  const next = parseOrcadMigrationSourceCutover({
    ...initial,
    phase: 'destination-staged',
    stagedAt: initial.startedAt
  })
  return {
    initial,
    next,
    store: restored,
    options: {
      profileDirectory: testState.dir,
      store: restored,
      migrationId: manifest.migrationId,
      next,
      signal: new AbortController().signal,
      assertAuthority: vi.fn()
    }
  }
}

it('durably advances a retained live journal, reloads, and permits exact retry', async () => {
  const f = await fixture()
  expect(await recordOrcadLiveCutoverProgressDurably(f.options)).toEqual(f.next)
  const restored = createStore()
  expect(restored.getOrcadMigrationSourceCutover(f.options.migrationId)).toEqual(f.next)
  expect(await recordOrcadLiveCutoverProgressDurably({ ...f.options, store: restored })).toEqual(
    f.next
  )
  expect(() =>
    restored.recordOrcadLiveCutoverProgress(f.options.migrationId, f.initial, f.next)
  ).toThrow('progress_stale')
})

it('does not acknowledge a failed flush and retries exact in-memory progress durably', async () => {
  const f = await fixture()
  vi.spyOn(f.store, 'flushPendingOrThrowAsync').mockRejectedValueOnce(new Error('disk unavailable'))
  await expect(recordOrcadLiveCutoverProgressDurably(f.options)).rejects.toThrow('disk unavailable')
  expect(f.store.getOrcadMigrationSourceCutover(f.options.migrationId)).toEqual(f.next)
  expect(await recordOrcadLiveCutoverProgressDurably(f.options)).toEqual(f.next)
  expect(createStore().getOrcadMigrationSourceCutover(f.options.migrationId)).toEqual(f.next)
})

it('does not acknowledge progress after authority changes during flush', async () => {
  const f = await fixture()
  const flush = f.store.flushPendingOrThrowAsync.bind(f.store)
  vi.spyOn(f.store, 'flushPendingOrThrowAsync').mockImplementationOnce(async (options) => {
    await flush(options)
    f.options.assertAuthority.mockImplementation(() => {
      throw new Error('authority changed')
    })
  })
  await expect(recordOrcadLiveCutoverProgressDurably(f.options)).rejects.toThrow(
    'authority changed'
  )
  expect(createStore().getOrcadMigrationSourceCutover(f.options.migrationId)).toEqual(f.next)
})

async function publicationFixture(terminalCount = 1, buffer?: string) {
  const f = await fixture(terminalCount, buffer)
  const cutover = await recordOrcadLiveCutoverProgressDurably(f.options)
  const { identity, surfaceBinding } = cutover.liveTerminalBindings![0]
  const result = {
    identity,
    publicationReceipt: {
      version: 1,
      publicationReceiptId: 'publication',
      bridgeId: identity.bridgeId,
      destinationRuntimeId: identity.destinationRuntimeId,
      surfaceBinding,
      publishedAt: cutover.startedAt,
      commitReceipt: {
        receiptId: 'commit',
        bridgeId: identity.bridgeId,
        acceptedSourceEndSeq: 1,
        committedAt: cutover.startedAt
      }
    }
  }
  terminals.create.mockImplementation(async (_root, args) => {
    args.assertAuthority()
    expect(args.binding.identity).toEqual(identity)
    expect(args.binding.catalogAdmission.bindings).toHaveLength(1)
    return { ...args.binding, surfaceBinding: args.surfaceBinding }
  })
  terminals.prepare.mockImplementation(async (_root, args, authority) => {
    authority.assertAuthority()
    expect(args.requireSavedPreparation).toBe(true)
    return result
  })
  return {
    ...f,
    result,
    publicationOptions: {
      ...f.options,
      cutover,
      pairingCode: 'pinned-pairing',
      runtime: { serializeSshPtyOwnershipCapture: vi.fn() },
      sourceAdmission: {
        fenceCreation: vi.fn(),
        bindings: cutover.liveTerminalBindings!,
        assertBindings: vi.fn(),
        assertCurrent: vi.fn(),
        assertRuntimeCurrent: vi.fn(),
        projectSourceState: (state: PersistedState) => state
      }
    }
  }
}

it('records terminal publication in a real journal and repeats exact receipts after reload', async () => {
  const f = await publicationFixture()
  const published = await publishOrcadLiveTerminals(f.publicationOptions)
  expect(published.phase).toBe('destination-staged')
  expect(published.terminalPublications).toEqual([
    {
      ...f.result,
      catalog: {
        migrationId: published.manifest.migrationId,
        manifestSha256: published.manifest.manifestSha256
      }
    }
  ])
  const restored = createStore()
  expect(restored.getOrcadMigrationSourceCutover(published.manifest.migrationId)).toEqual(published)
  expect(
    await publishOrcadLiveTerminals({
      ...f.publicationOptions,
      store: restored,
      cutover: published
    })
  ).toEqual(published)
  expect(terminals.prepare).toHaveBeenCalledTimes(2)
})

it('retains staged authority on lost publication reply and recovers through exact retry', async () => {
  const f = await publicationFixture()
  terminals.prepare.mockRejectedValueOnce(new Error('reply lost'))
  await expect(publishOrcadLiveTerminals(f.publicationOptions)).rejects.toThrow('reply lost')
  expect(createStore().getOrcadMigrationSourceCutover(f.options.migrationId)).toEqual(f.next)
  expect((await publishOrcadLiveTerminals(f.publicationOptions)).terminalPublications).toHaveLength(
    1
  )
})

it('does not acknowledge uncertain publication journal durability and reflushes the same receipt', async () => {
  const f = await publicationFixture()
  vi.spyOn(f.store, 'flushPendingOrThrowAsync').mockRejectedValueOnce(new Error('disk unavailable'))
  await expect(publishOrcadLiveTerminals(f.publicationOptions)).rejects.toThrow('disk unavailable')
  const retained = f.store.getOrcadMigrationSourceCutover(f.options.migrationId)!
  expect(retained.terminalPublications).toHaveLength(1)
  const retried = await publishOrcadLiveTerminals({ ...f.publicationOptions, cutover: retained })
  expect(createStore().getOrcadMigrationSourceCutover(f.options.migrationId)).toEqual(retried)
})

it('refuses a changed publication receipt on retry without overwriting durable evidence', async () => {
  const f = await publicationFixture()
  const published = await publishOrcadLiveTerminals(f.publicationOptions)
  f.result.publicationReceipt.publicationReceiptId = 'replacement'
  await expect(
    publishOrcadLiveTerminals({ ...f.publicationOptions, cutover: published })
  ).rejects.toThrow('publication_evidence_changed')
  expect(createStore().getOrcadMigrationSourceCutover(f.options.migrationId)).toEqual(published)
})

it('refuses stale journal authority before credential creation', async () => {
  const f = await publicationFixture()
  await expect(
    publishOrcadLiveTerminals({
      ...f.publicationOptions,
      cutover: { ...f.next, updatedAt: '2026-09-07T00:00:00.000Z' }
    })
  ).rejects.toThrow('progress_stale')
  expect(terminals.create).not.toHaveBeenCalled()
  expect(terminals.prepare).not.toHaveBeenCalled()
})

it('refuses lost source admission after publication without recording a receipt', async () => {
  const f = await publicationFixture()
  terminals.prepare.mockImplementationOnce(async () => {
    f.publicationOptions.sourceAdmission.assertBindings.mockImplementation(() => {
      throw new Error('source changed')
    })
    return f.result
  })
  await expect(publishOrcadLiveTerminals(f.publicationOptions)).rejects.toThrow('source changed')
  expect(createStore().getOrcadMigrationSourceCutover(f.options.migrationId)).toEqual(f.next)
})

async function commitFixture(buffer?: string) {
  const f = await publicationFixture(1, buffer)
  const published = await publishOrcadLiveTerminals(f.publicationOptions)
  const identity = {
    migrationId: published.manifest.migrationId,
    manifestSha256: published.manifest.manifestSha256
  }
  const staged = {
    ...identity,
    state: 'staged',
    stagedAt: published.startedAt,
    snapshotUploads: (
      published.manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
    ).map((entry) => ({ ...entry, receivedBytes: entry.byteLength }))
  }
  const committed = { ...identity, state: 'committed', receipt: receipt(published.manifest) }
  const remote = {
    read: vi.fn().mockResolvedValue(staged),
    commit: vi.fn().mockResolvedValue(committed)
  }
  return {
    ...f,
    published,
    staged,
    committed,
    commitOptions: { ...f.publicationOptions, cutover: published, remote }
  }
}

it('commits only complete publication evidence and durably reloads without retiring the source', async () => {
  const f = await commitFixture()
  const owner = f.store.getSshTarget(f.published.manifest.source.sshTargetId)?.owner
  const committed = await commitOrcadLiveDestination(f.commitOptions)
  expect(committed.phase).toBe('destination-committed')
  expect(committed.terminalPublications).toEqual(f.published.terminalPublications)
  expect(createStore().getOrcadMigrationSourceCutover(f.options.migrationId)).toEqual(committed)
  expect(f.store.getSshTarget(f.published.manifest.source.sshTargetId)?.owner).toEqual(owner)
  expect(f.commitOptions.remote.commit).toHaveBeenCalledWith(
    'pinned-pairing',
    f.published.manifest,
    { signal: f.commitOptions.signal, expectedRuntimeId: 'runtime' }
  )
})

it('rejects legacy retirement of committed live transfers without changing source data', async () => {
  const f = await commitFixture('preserved source scrollback')
  const committed = await commitOrcadLiveDestination(f.commitOptions)
  const disk = readDataFile()
  const repos = f.store.getRepos()
  const session = f.store.getWorkspaceSession(`ssh:${TARGET.id}`)
  expect(() => f.store.retireOrcadMigrationSourceCatalog(f.options.migrationId)).toThrow(
    'orcad_migration_live_cutover_coordinator_required'
  )
  expect(f.store.getRepos()).toEqual(repos)
  expect(f.store.getWorkspaceSession(`ssh:${TARGET.id}`)).toEqual(session)
  await f.store.flushPendingOrThrowAsync()
  expect(readDataFile()).toEqual(disk)
  expect(createStore().getOrcadMigrationSourceCutover(f.options.migrationId)).toEqual(committed)
})

it('requires complete terminal coverage before any destination commit call', async () => {
  const f = await publicationFixture()
  const remote = { read: vi.fn(), commit: vi.fn() }
  await expect(commitOrcadLiveDestination({ ...f.publicationOptions, remote })).rejects.toThrow(
    'completion_evidence_required'
  )
  expect(remote.read).not.toHaveBeenCalled()
  expect(remote.commit).not.toHaveBeenCalled()
})

it('recovers a lost commit reply only after an acknowledged idempotent reflush', async () => {
  const f = await commitFixture()
  f.commitOptions.remote.commit.mockRejectedValueOnce(new Error('reply lost'))
  f.commitOptions.remote.read.mockResolvedValueOnce(f.staged).mockResolvedValue(f.committed)
  const committed = await commitOrcadLiveDestination(f.commitOptions)
  expect(committed.phase).toBe('destination-committed')
  expect(f.commitOptions.remote.commit).toHaveBeenCalledTimes(2)
  expect(createStore().getOrcadMigrationSourceCutover(f.options.migrationId)).toEqual(committed)
})

it('does not treat an in-memory committed observation as durable when destination flush keeps failing', async () => {
  const f = await commitFixture()
  f.commitOptions.remote.commit.mockRejectedValue(new Error('destination disk unavailable'))
  f.commitOptions.remote.read.mockResolvedValueOnce(f.staged).mockResolvedValue(f.committed)
  await expect(commitOrcadLiveDestination(f.commitOptions)).rejects.toThrow(
    'destination disk unavailable'
  )
  expect(f.commitOptions.remote.commit).toHaveBeenCalledTimes(2)
  expect(createStore().getOrcadMigrationSourceCutover(f.options.migrationId)).toEqual(f.published)
})

it('reflushes an already committed destination on exact journal retry', async () => {
  const f = await commitFixture()
  const committed = await commitOrcadLiveDestination(f.commitOptions)
  f.commitOptions.remote.read.mockResolvedValue(f.committed)
  expect(await commitOrcadLiveDestination({ ...f.commitOptions, cutover: committed })).toEqual(
    committed
  )
  expect(f.commitOptions.remote.commit).toHaveBeenCalledTimes(2)
  const remote = { ...f.commitOptions.remote, stage: vi.fn(), snapshot: vi.fn() }
  const preparedCount = terminals.prepare.mock.calls.length
  expect(
    await migrateOrcadLiveDestination({ ...f.commitOptions, cutover: committed, remote })
  ).toEqual(committed)
  expect(remote.stage).not.toHaveBeenCalled()
  expect(remote.snapshot).not.toHaveBeenCalled()
  expect(terminals.prepare).toHaveBeenCalledTimes(preparedCount)
})

it('refuses an absent destination after publication without attempting commit', async () => {
  const f = await commitFixture()
  f.commitOptions.remote.read.mockResolvedValue({ ...f.staged, state: 'absent' })
  await expect(commitOrcadLiveDestination(f.commitOptions)).rejects.toThrow('state_regressed')
  expect(f.commitOptions.remote.commit).not.toHaveBeenCalled()
})

it('composes staging, terminal publication and catalog commit with a real durable source journal', async () => {
  const f = await commitFixture()
  const remote = {
    ...f.commitOptions.remote,
    stage: vi.fn().mockResolvedValue(f.staged),
    snapshot: vi.fn()
  }
  const result = await migrateOrcadLiveDestination({ ...f.commitOptions, remote })
  expect(result.phase).toBe('destination-committed')
  expect(remote.stage).toHaveBeenCalledOnce()
  expect(remote.commit).toHaveBeenCalledOnce()
  expect(createStore().getOrcadMigrationSourceCutover(f.options.migrationId)).toEqual(result)
})

it('retains the first tab publication when the second fails and resumes both exact identities', async () => {
  const f = await publicationFixture(2)
  terminals.create.mockImplementation(async (_root, args) => {
    args.assertAuthority()
    expect(args.binding.catalogAdmission.bindings).toHaveLength(1)
    expect(args.binding.catalogAdmission.bindings[0].surfaceBinding.tabId).toBe(
      args.surfaceBinding.tabId
    )
    return { ...args.binding, surfaceBinding: args.surfaceBinding }
  })
  let failSecond = true
  terminals.prepare.mockImplementation(async (_root, args, authority) => {
    authority.assertAuthority()
    const { identity, surfaceBinding } = args.preparation
    if (identity.bridgeId === 'bridge-1' && failSecond) {
      expect(
        createStore().getOrcadMigrationSourceCutover(f.options.migrationId)?.terminalPublications
      ).toHaveLength(1)
      throw new Error('second reply lost')
    }
    return {
      identity,
      publicationReceipt: {
        ...f.result.publicationReceipt,
        publicationReceiptId: `receipt-${identity.bridgeId}`,
        bridgeId: identity.bridgeId,
        surfaceBinding,
        commitReceipt: { ...f.result.publicationReceipt.commitReceipt, bridgeId: identity.bridgeId }
      }
    }
  })
  await expect(publishOrcadLiveTerminals(f.publicationOptions)).rejects.toThrow('second reply lost')
  const restored = createStore()
  const partial = restored.getOrcadMigrationSourceCutover(f.options.migrationId)!
  const remote = { read: vi.fn(), commit: vi.fn() }
  await expect(
    commitOrcadLiveDestination({
      ...f.publicationOptions,
      store: restored,
      cutover: partial,
      remote
    })
  ).rejects.toThrow('completion_evidence_required')
  expect(remote.commit).not.toHaveBeenCalled()
  failSecond = false
  const complete = await publishOrcadLiveTerminals({
    ...f.publicationOptions,
    store: restored,
    cutover: partial
  })
  expect(complete.terminalPublications).toHaveLength(2)
  expect(complete.terminalPublications![0]).toEqual(partial.terminalPublications![0])
  expect(createStore().getOrcadMigrationSourceCutover(f.options.migrationId)).toEqual(complete)
})

it.each(['incomplete', 'missing'] as const)(
  'refuses catalog commit when live snapshot upload evidence is %s',
  async (mode) => {
    const f = await commitFixture('snapshot must not disappear 🐙')
    expect(f.staged.snapshotUploads).toHaveLength(1)
    const snapshotUploads =
      mode === 'missing'
        ? undefined
        : f.staged.snapshotUploads.map((entry) => ({
            ...entry,
            receivedBytes: entry.byteLength - 1
          }))
    f.commitOptions.remote.read.mockResolvedValue({ ...f.staged, snapshotUploads })
    await expect(commitOrcadLiveDestination(f.commitOptions)).rejects.toThrow(
      mode === 'missing' ? 'snapshot_transfer_unsupported' : 'snapshot_transfer_incomplete'
    )
    expect(f.commitOptions.remote.commit).not.toHaveBeenCalled()
    expect(createStore().getOrcadMigrationSourceCutover(f.options.migrationId)).toEqual(f.published)
  }
)
