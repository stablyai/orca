import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createStore, testState, dataFile } from './persistence-test-harness'
import {
  terminalLayoutAdmissionFixture,
  sealAdmissionManifest
} from './persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import { PtyOwnershipTransferDestinationFileStore } from './persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store'
import { ptyOwnershipTransferDestinationDirectory } from './persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store-contract'
import { collectDeregisteredRepoIds } from './persistence/tracking-repos/deregistered-repo-residue'
import { mergeWorkspaceSessions } from './orca-profiles/profile-project-session-state'
import {
  getProfileTerminalScrollbackSnapshotRoot,
  getTerminalScrollbackSnapshotPath
} from './terminal-scrollback-snapshots'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-catalog-surface-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

function setup(kind: 'folder' | 'worktree', multiTab = false) {
  const fixture = terminalLayoutAdmissionFixture(kind)
  if (multiTab) {
    const session = fixture.manifest.payload.dormantState!.workspaceSession!
    session.tabsByWorktree[fixture.owner].push({
      ...session.tabsByWorktree[fixture.owner][0],
      id: 'dormant-extra'
    })
    fixture.manifest = sealAdmissionManifest(fixture.manifest)
    fixture.admission = { ...fixture.admission, manifest: fixture.manifest }
  }
  const store = createStore()
  store.stageOrcadMigrationCatalog(fixture.manifest)
  store.flushOrThrow()
  const directory = ptyOwnershipTransferDestinationDirectory(testState.dir)
  const transfers = new PtyOwnershipTransferDestinationFileStore({ directory })
  const publisher = new PtyOwnershipTransferDestinationFileStore({
    directory,
    catalogPublicationVersion: 1
  })
  const requests = fixture.bindings.map(({ identity, surfaceBinding }) => {
    transfers.prepare(identity, 0)
    transfers.bindDelegatedSource(identity, {
      version: 1,
      proof: { ...identity, version: 1, credential: 'a'.repeat(64) },
      endpoint: '/source.sock',
      incumbentVersion: 'test',
      endpointCredential: 'test'
    })
    transfers.surface.bindCatalogAdmission(identity, fixture.admission)
    const receipt = {
      bridgeId: identity.bridgeId,
      receiptId: `receipt-${identity.bridgeId}`,
      acceptedSourceEndSeq: 0,
      committedAt: '2026-09-06T00:00:00.000Z'
    }
    transfers.commit(identity, receipt)
    expect(() => transfers.reservePublication(identity, receipt)).toThrow(
      'pty_ownership_transfer_catalog_publication_not_supported'
    )
    const publicationReceipt = publisher.reservePublication(identity, receipt)
    return { identity, surfaceBinding, publicationReceipt, frames: [] }
  })
  return { ...fixture, store, requests, directory }
}

it.each([
  ['folder', 0, 1],
  ['folder', 1, 0],
  ['worktree', 0, 1],
  ['worktree', 1, 0]
] as const)(
  'publishes %s reserved split in order %i/%i, checkpoints and reloads',
  (kind, first, second) => {
    const f = setup(kind)
    expect(f.store.inspectPtyOwnershipTransferSurface(f.requests[first])).toBe('absent')
    f.store.publishPtyOwnershipTransferSurface(f.requests[first])
    let restored = createStore()
    expect(restored.inspectPtyOwnershipTransferSurface(f.requests[first])).toBe('published')
    expect(restored.inspectPtyOwnershipTransferSurface(f.requests[second])).toBe('absent')
    restored.checkpointPtyOwnershipTransferTerminalModel({
      ...f.requests[first],
      modelData: 'host-owned history'
    })
    restored.publishPtyOwnershipTransferSurface(f.requests[second])
    const beforeCommit = structuredClone(restored.getWorkspaceSession())
    expect(restored.commitStagedOrcadMigrationCatalog(f.manifest).state).toBe('committed')
    expect(restored.getWorkspaceSession()).toEqual(
      mergeWorkspaceSessions(beforeCommit, beforeCommit)
    )
    restored.flushOrThrow()
    restored = createStore()
    expect(restored.getOrcadMigrationCatalogState(f.manifest).state).toBe('committed')
    expect(restored.commitStagedOrcadMigrationCatalog(f.manifest).state).toBe('committed')
    for (const request of f.requests) {
      expect(restored.inspectPtyOwnershipTransferSurface(request)).toBe('published')
      expect(() => restored.publishPtyOwnershipTransferSurface(request)).not.toThrow()
    }
    const session = restored.getWorkspaceSession()
    expect(session.tabsByWorktree[f.owner][0].ptyId).toBe(f.requests[0].identity.terminalId)
    expect(session.terminalLayoutsByTabId['tab-1'].root).toEqual(
      f.manifest.payload.dormantState!.workspaceSession!.terminalLayoutsByTabId['tab-1'].root
    )
  }
)

it('refuses another pane when its published sibling journal disappears', () => {
  const f = setup('worktree')
  f.store.publishPtyOwnershipTransferSurface(f.requests[0])
  const before = structuredClone(f.store.getWorkspaceSession())
  const file = join(
    f.directory,
    `${createHash('sha256').update(f.requests[0].identity.bridgeId).digest('hex')}.json`
  )
  rmSync(file)
  expect(f.store.inspectPtyOwnershipTransferSurface(f.requests[1])).toBe('conflict')
  expect(() => f.store.publishPtyOwnershipTransferSurface(f.requests[1])).toThrow(
    'pty_ownership_transfer_surface_conflict'
  )
  expect(f.store.getWorkspaceSession()).toEqual(before)
})

it('does not substitute a syntactically valid foreign history ref', () => {
  const f = setup('folder')
  f.store.publishPtyOwnershipTransferSurface(f.requests[0])
  const session = f.store.getWorkspaceSession()
  session.terminalLayoutsByTabId['tab-1'].scrollbackRefsByLeafId![
    f.requests[0].surfaceBinding.leafId
  ] = `v1-${'f'.repeat(32)}`
  expect(f.store.inspectPtyOwnershipTransferSurface(f.requests[1])).toBe('conflict')
})

it('supports publication and an explicit empty checkpoint after dormant catalog commit removed the stage', () => {
  const f = setup('worktree')
  f.store.commitStagedOrcadMigrationCatalog(f.manifest)
  f.store.flushOrThrow()
  f.store.publishPtyOwnershipTransferSurface(f.requests[0])
  f.store.checkpointPtyOwnershipTransferTerminalModel({
    ...f.requests[0],
    modelData: '',
    allowEmpty: true
  })
  const restored = createStore()
  expect(restored.inspectPtyOwnershipTransferSurface(f.requests[0])).toBe('published')
  expect(() => restored.publishPtyOwnershipTransferSurface(f.requests[1])).not.toThrow()
})

it('holds deregistered-repo cleanup only while a stage still owns that repository', () => {
  const f = terminalLayoutAdmissionFixture()
  f.state.workspaceSession = structuredClone(f.manifest.payload.dormantState!.workspaceSession!)
  f.state.repos = []
  expect(collectDeregisteredRepoIds(f.state).has('repo-1')).toBe(false)
  f.state.orcadMigrationStagedCatalogs = []
  expect(collectDeregisteredRepoIds(f.state).has('repo-1')).toBe(true)
})

it('does not return catalog admission when its host flush fails', () => {
  const f = setup('folder')
  const before = structuredClone(f.store.getWorkspaceSession())
  vi.spyOn(f.store, 'flushOrThrow').mockImplementationOnce(() => {
    throw new Error('disk unavailable')
  })
  expect(() => f.store.preparePtyOwnershipTransferCatalogAdmission(f.manifest, f.bindings)).toThrow(
    'disk unavailable'
  )
  expect(f.store.getWorkspaceSession()).toEqual(before)
})

it.each(['folder', 'worktree'] as const)(
  'commits a partial %s split and publishes its sibling after reload',
  (kind) => {
    const f = setup(kind)
    f.store.publishPtyOwnershipTransferSurface(f.requests[1])
    expect(f.store.preparePtyOwnershipTransferCatalogAdmission(f.manifest, f.bindings)).toEqual(
      f.admission
    )
    expect(f.store.stageOrcadMigrationCatalog(f.manifest).state).toBe('staged')
    expect(f.store.commitStagedOrcadMigrationCatalog(f.manifest).state).toBe('committed')
    f.store.flushOrThrow()
    const restored = createStore()
    expect(restored.getOrcadMigrationCatalogState(f.manifest).state).toBe('committed')
    restored.publishPtyOwnershipTransferSurface(f.requests[0])
    expect(restored.importOrcadMigrationCatalog(f.manifest).status).toBe('already-imported')
    expect(restored.stageOrcadMigrationCatalog(f.manifest).state).toBe('committed')
  }
)

it.each(['folder', 'worktree'] as const)(
  'commits partially materialized %s tab membership but refuses missing committed tabs',
  (kind) => {
    const f = setup(kind, true)
    f.store.publishPtyOwnershipTransferSurface(f.requests[1])
    expect(f.store.getWorkspaceSession().tabsByWorktree[f.owner]).toHaveLength(1)
    f.store.commitStagedOrcadMigrationCatalog(f.manifest)
    f.store.flushOrThrow()
    const restored = createStore()
    expect(restored.getWorkspaceSession().tabsByWorktree[f.owner].map((tab) => tab.id)).toEqual([
      'tab-1',
      'dormant-extra'
    ])
    expect(restored.getOrcadMigrationCatalogState(f.manifest).state).toBe('committed')
    restored.getWorkspaceSession().tabsByWorktree[f.owner].pop()
    expect(() => restored.commitStagedOrcadMigrationCatalog(f.manifest)).toThrow(
      'orcad_migration_live_session_owner_conflict'
    )
    expect(restored.getWorkspaceSession().tabsByWorktree[f.owner]).toHaveLength(1)
  }
)

it.each(['journal-missing', 'artifact-missing', 'static-drift'])(
  'refuses commit with %s without removing stage or replacing live state',
  (kind) => {
    const f = setup('worktree')
    f.store.publishPtyOwnershipTransferSurface(f.requests[0])
    if (kind === 'journal-missing') {
      rmSync(
        join(
          f.directory,
          `${createHash('sha256').update(f.requests[0].identity.bridgeId).digest('hex')}.json`
        )
      )
    } else if (kind === 'artifact-missing') {
      const ref =
        f.store.getWorkspaceSession().terminalLayoutsByTabId['tab-1'].scrollbackRefsByLeafId![
          f.requests[0].surfaceBinding.leafId
        ]
      rmSync(
        getTerminalScrollbackSnapshotPath(ref, {
          snapshotRoot: getProfileTerminalScrollbackSnapshotRoot(dataFile())
        })!
      )
    } else {
      f.store.getWorkspaceSession().tabsByWorktree[f.owner][0].title = 'changed'
    }
    const before = structuredClone(f.store.getWorkspaceSession())
    expect(() => f.store.commitStagedOrcadMigrationCatalog(f.manifest)).toThrow()
    expect(f.store.getWorkspaceSession()).toEqual(before)
    expect(f.store.getOrcadMigrationCatalogState(f.manifest).state).toBe('staged')
    expect(f.store.getRepos()).toEqual([])
  }
)
