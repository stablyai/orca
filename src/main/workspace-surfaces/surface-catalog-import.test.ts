import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import {
  buildCanonicalRunWorkers,
  canonicalRunWorkerOptions
} from '../ipc/pty/canonical-pty-run-test-support'
import { createLiveProfileStateStore } from '../persistence/profile-state/profile-state-live-store-factory'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import type { Store } from '../persistence/loading-store/store'
import {
  DORMANT_WORKTREE_ID,
  DORMANT_LEAF_ID,
  dormantState,
  manifest
} from '../persistence/migrating-orcad-catalog/persistence-orcad-migration-catalog-fixture'
import {
  commitStagedOrcadMigrationCatalogDurably,
  stageOrcadMigrationCatalogDurably
} from '../runtime/orcad-migration-catalog-import'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

let bundleRoot: string
const roots: string[] = []
const stores: Store[] = []
beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'orca-catalog-workers-'))
  await buildCanonicalRunWorkers(bundleRoot)
})
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.freezeWritesAsync()))
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

async function open(input?: { dataFile: string; databaseFile: string; profileId: string }) {
  if (!input) {
    const root = mkdtempSync(join(tmpdir(), 'orca-catalog-profile-'))
    roots.push(root)
    input = {
      dataFile: join(root, 'orca-data.json'),
      databaseFile: join(root, 'profile-state.db'),
      profileId: 'catalog-test'
    }
  }
  const { store } = await createLiveProfileStateStore(input, canonicalRunWorkerOptions(bundleRoot))
  stores.push(store)
  return { store, input }
}

function read(input: { databaseFile: string; profileId: string }) {
  const reader = new ProfileStateSqliteAuthority(input.databaseFile, input.profileId)
  try {
    return JSON.parse(reader.readSerializedState()!)
  } finally {
    reader.close()
  }
}

function carriedCatalog() {
  const base = manifest()
  const dormant = dormantState()
  const paneKey = `tab-dormant:${DORMANT_LEAF_ID}`
  dormant.workspaceSession!.sleepingAgentSessionsByPaneKey = {
    [paneKey]: {
      paneKey,
      worktreeId: DORMANT_WORKTREE_ID,
      tabId: 'tab-dormant',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'dormant-resume' },
      prompt: '',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
  }
  return manifest({
    source: {
      kind: 'local-wsl',
      distro: 'Ubuntu',
      scopeRepoIds: ['repo-1'],
      scopeFolderWorkspaceIds: ['folder-1'],
      generation: 1
    },
    payload: { ...base.payload, dormantState: dormant }
  })
}

it('adopts a durably staged terminal import before announcement and never replays it over a later close', async () => {
  const { store, input } = await open()
  store.addRepo({
    id: 'current',
    path: input.dataFile,
    displayName: 'Current',
    badgeColor: 'gray',
    addedAt: 1
  })
  const current = 'current::/work'
  await store.admitTerminalRun({
    type: 'createTerminalTab',
    workspace: current,
    tabId: 'current-tab',
    leafId: '339343d0-9fcb-4d4d-8bf6-69615be0f927'
  })
  const incoming = carriedCatalog()
  await stageOrcadMigrationCatalogDurably({ store, manifest: incoming })
  const commit = () =>
    commitStagedOrcadMigrationCatalogDurably({
      store,
      manifest: incoming,
      onDurableCommit: () => {
        expect(store.getWorkspaceSession().tabsByWorktree[current]).toHaveLength(1)
        expect(
          store
            .readWorkspaceSurfaces()
            .some(
              (surface) =>
                surface.hostTabId === 'tab-dormant' && surface.content?.kind === 'terminal'
            )
        ).toBe(true)
      }
    })
  await expect(commit()).resolves.toMatchObject({ state: 'committed' })
  expect(
    read(input).workspaceSurfaces.hosts.local.surfaces.some(
      (surface: { hostTabId: string }) => surface.hostTabId === 'tab-dormant'
    )
  ).toBe(true)
  await store.freezeWritesAsync()
  const reopened = (await open(input)).store
  expect(reopened.getWorkspaceSession().tabsByWorktree[DORMANT_WORKTREE_ID]).toHaveLength(1)
  expect(reopened.getWorkspaceSession().tabsByWorktree[current]).toHaveLength(1)
  expect(
    await reopened.applyLayoutCommand({
      type: 'closeTabs',
      workspace: DORMANT_WORKTREE_ID,
      tabIds: ['tab-dormant'],
      force: true
    })
  ).toMatchObject({ ok: true })
  await commitStagedOrcadMigrationCatalogDurably({
    store: reopened,
    manifest: incoming,
    onDurableCommit: () => {}
  })
  expect(reopened.getWorkspaceSession().tabsByWorktree[DORMANT_WORKTREE_ID]).toEqual([])
  await reopened.freezeWritesAsync()
  expect(
    (await open(input)).store.getWorkspaceSession().tabsByWorktree[DORMANT_WORKTREE_ID]
  ).toEqual([])
})

it('rolls back the carried terminal seed when the catalog receipt write is rejected', async () => {
  const { store, input } = await open()
  const incoming = carriedCatalog()
  await stageOrcadMigrationCatalogDurably({ store, manifest: incoming })
  const fixture = new Database(input.databaseFile)
  fixture.exec(
    "CREATE TRIGGER reject_catalog_receipt BEFORE INSERT ON profile_state_documents WHEN NEW.domain = 'orcadMigrationImportReceipts' BEGIN SELECT RAISE(ABORT, 'reject catalog receipt'); END"
  )
  let announced = false
  try {
    await expect(
      commitStagedOrcadMigrationCatalogDurably({
        store,
        manifest: incoming,
        onDurableCommit: () => {
          announced = true
        }
      })
    ).rejects.toMatchObject({ code: 'profile-state-write-failed', outcome: 'known-failure' })
    const saved = read(input)
    expect(saved.workspaceSurfaces.hosts.local.surfaces).toEqual([])
    expect(saved.orcadMigrationImportReceipts ?? []).toEqual([])
    expect(saved.orcadMigrationStagedCatalogs).toHaveLength(1)
    expect(announced).toBe(false)
  } finally {
    fixture.exec('DROP TRIGGER reject_catalog_receipt')
    fixture.close()
  }
  await expect(
    commitStagedOrcadMigrationCatalogDurably({
      store,
      manifest: incoming,
      onDurableCommit: () => {
        announced = true
      }
    })
  ).resolves.toMatchObject({ state: 'committed' })
  expect(announced).toBe(true)
  await store.freezeWritesAsync()
  const reopened = (await open(input)).store
  const saved = read(input)
  expect(saved.orcadMigrationStagedCatalogs).toEqual([])
  expect(saved.orcadMigrationImportReceipts).toHaveLength(1)
  expect(reopened.getWorkspaceSession().tabsByWorktree[DORMANT_WORKTREE_ID]).toHaveLength(1)
  expect(
    reopened.readWorkspaceSurfaces().filter((surface) => surface.content !== null)
  ).toHaveLength(1)
})

it('replays an initialized-empty import after committed refresh failure without losing its dormant state', async () => {
  const { store, input } = await open()
  const incoming = carriedCatalog()
  await stageOrcadMigrationCatalogDurably({ store, manifest: incoming })
  const refresh = vi
    .spyOn(store, 'executeWorkspaceSurfaceCommand')
    .mockRejectedValueOnce(new Error('refresh interrupted'))
  const announce = vi.fn()
  await expect(
    commitStagedOrcadMigrationCatalogDurably({
      store,
      manifest: incoming,
      onDurableCommit: announce
    })
  ).rejects.toThrow('refresh interrupted')
  expect(announce).not.toHaveBeenCalled()
  expect(read(input).orcadMigrationImportReceipts).toHaveLength(1)
  await expect(
    commitStagedOrcadMigrationCatalogDurably({
      store,
      manifest: incoming,
      onDurableCommit: announce
    })
  ).resolves.toMatchObject({ state: 'committed' })
  expect(announce).toHaveBeenCalledTimes(1)
  refresh.mockRestore()
  await store.freezeWritesAsync()
  const reopened = (await open(input)).store
  await commitStagedOrcadMigrationCatalogDurably({
    store: reopened,
    manifest: incoming,
    onDurableCommit: announce
  })
  const session = reopened.getWorkspaceSession()
  const carried = incoming.payload.dormantState!.workspaceSession!
  expect(session.tabsByWorktree[DORMANT_WORKTREE_ID]).toHaveLength(1)
  expect(session.terminalLayoutsByTabId['tab-dormant'].ptyIdsByLeafId ?? {}).toEqual({})
  expect(session.sleepingAgentSessionsByPaneKey).toEqual(carried.sleepingAgentSessionsByPaneKey)
  expect(
    reopened.readWorkspaceSurfaces().filter((surface) => surface.content !== null)
  ).toHaveLength(1)
})
