import { surfaceAdmissionValid, releaseSurfaceAdmissions } from './surface-admission-capture'
import type { SurfaceStorageMutation } from '../../shared/workspace-surfaces/surface-storage-command'
import { randomUUID } from 'node:crypto'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'
import { seedTestAgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store-test-harness'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabase,
  closeTestJournalHostDatabases
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { installSurfaceNativeRuntimeOwner } from './surface-native-runtime-owner'
import { commitCanonicalResumeRecordEdit } from '../runtime/terminal/stop/canonical-resume-record-edit'
import { exportWslMoveManifest } from '../persistence/moving-wsl-projects/wsl-move-manifest-export'
import { wslMoveCutoverFixture } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { registerWslMoveMainRewriteStores } from '../persistence/moving-wsl-projects/wsl-move-main-rewrite-stores'
import { resetWslMoveDesktopRewriteStoresForTests } from '../persistence/moving-wsl-projects/wsl-move-desktop-rewrite-stores'
import {
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { runWslMoveDesktopRewritePass } from '../persistence/moving-wsl-projects/wsl-move-desktop-rewrite'
import { runWslMoveRetentionPass } from '../persistence/moving-wsl-projects/wsl-move-retention'
import { listWslMoveCutovers } from '../persistence/moving-wsl-projects/wsl-move-cutover-journal'
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
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  resetWslMoveFenceForTests()
  await closeTestJournalHostDatabases()
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
  fixture.exec('PRAGMA busy_timeout = 5000')
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
  const captured: SurfaceStorageMutation = {
    type: 'replace',
    hostId: 'local',
    request: {
      hostId: 'local',
      workspaceId: DORMANT_WORKTREE_ID,
      hostTabId: 'tab-dormant',
      callerId: 'held-before-import',
      commandId: randomUUID(),
      expiresAt: Date.now() + 600_000,
      expected: null,
      content: null
    }
  }
  store.captureWorkspaceSurfaceAdmission(captured)
  expect(surfaceAdmissionValid(captured)).toBe(true)
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
  expect(surfaceAdmissionValid(captured)).toBe(false)
  releaseSurfaceAdmissions([captured])
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

it('retains source canonical native membership and exact resource debt through a real WSL catalog transfer and reopen', async () => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  const { store: source, input: sourceInput } = await open()
  const { store: destination, input: destinationInput } = await open()
  const sourceRoot = join(sourceInput.dataFile, '..')
  const unc = String.raw`\\wsl.localhost\Ubuntu\home\me\app`
  const moved = `app::${unc}`
  const onHost = 'app::/home/me/app'
  const unrelated = String.raw`win::C:\code\win`
  const leafId = '339343d0-9fcb-4d4d-8bf6-69615be0f927'
  for (const [id, path] of [
    ['app', unc],
    ['win', String.raw`C:\code\win`]
  ] as const) {
    source.addRepo({ id, path, displayName: id, badgeColor: 'gray', addedAt: 1 })
  }
  const admitted = await source.admitTerminalRun({
    type: 'createTerminalTab',
    workspace: moved,
    tabId: 'moved-tab',
    leafId
  })
  const independent = await source.admitTerminalRun({
    type: 'createTerminalTab',
    workspace: unrelated,
    tabId: 'unrelated-tab',
    leafId: 'b5dc0f29-54c8-4325-9c37-c61dcaa09bdc'
  })
  expect(admitted.target).toBeDefined()
  expect(independent.target).toBeDefined()
  await source.executeWorkspaceSurfaceCommand({
    type: 'begin-run',
    hostId: 'local',
    target: admitted.target!,
    resourceId: 'old-resource',
    executorId: 'old-E',
    provenance: {
      platform: 'linux',
      machineId: 'executor',
      kernel: { scheme: 'linux-boot-id-v1', value: '22222222-2222-4222-8222-222222222222' }
    }
  })
  const aborted = await source.executeWorkspaceSurfaceCommand({
    type: 'abort-run',
    hostId: 'local',
    allocationId: admitted.target!.runId
  })
  const debt = aborted.allocations.find(
    (allocation) => allocation.allocationId === admitted.target!.runId
  )!
  expect(debt).toMatchObject({
    decision: 'aborting',
    resourceId: 'old-resource',
    executorId: 'old-E'
  })
  const paneKey = `moved-tab:${leafId}`
  await commitCanonicalResumeRecordEdit(source, 'local', (session) => ({
    ...session,
    sleepingAgentSessionsByPaneKey: {
      ...session.sleepingAgentSessionsByPaneKey,
      [paneKey]: {
        paneKey,
        worktreeId: moved,
        tabId: 'moved-tab',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'wsl-resume' },
        prompt: '',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'worktree-sleep'
      }
    }
  }))
  await seedTestAgentSessionRecordStore(sourceRoot, {
    records: [
      agentSessionRecordFixture({
        sessionId: 'chat-local',
        location: {
          executionHostId: 'local',
          workspaceId: moved,
          workspaceKind: 'git-worktree'
        }
      })
    ],
    sessionTabs: [{ sessionId: 'chat-local', tabId: 'chat-tab' }]
  })
  let journal = await openTestJournalHostDatabase(sourceRoot)
  await installSurfaceNativeRuntimeOwner(journal, source, 'local')
  source.patchWorkspaceSession({ activeWorktreeId: moved, activeWorkspaceExecutionHostId: 'local' })
  await source.flushPendingOrThrowAsync()
  const exported = exportWslMoveManifest(source, {
    migrationId: 'move-1',
    now: () => new Date('2026-11-03T00:00:00.000Z'),
    distro: 'Ubuntu',
    destinationEnvironmentId: 'wsl:Ubuntu',
    generation: 1,
    repoIds: ['app'],
    folderWorkspaceIds: []
  })
  expect(exported.blockers).toEqual([])
  if (!('kind' in exported.manifest.source) || exported.manifest.source.kind !== 'local-wsl') {
    throw new Error('Expected the actual local WSL export')
  }
  expect(exported.worktrees).toContainEqual({
    sourceWorktreeId: moved,
    destinationWorktreeId: onHost
  })
  const carried = exported.manifest.payload.dormantState!.workspaceSession!
  expect(carried.tabsByWorktree[unrelated]).toBeUndefined()
  expect(carried.tabsByWorktree[onHost].map((tab) => tab.ptyId)).toEqual([null])
  expect(carried.sleepingAgentSessionsByPaneKey?.[paneKey]?.worktreeId).toBe(onHost)
  await stageOrcadMigrationCatalogDurably({ store: destination, manifest: exported.manifest })
  await commitStagedOrcadMigrationCatalogDurably({
    store: destination,
    manifest: exported.manifest,
    onDurableCommit: () => {
      expect(destination.getWorkspaceSession().tabsByWorktree[onHost]).toHaveLength(1)
    }
  })
  const received = await destination.executeWorkspaceSurfaceCommand({
    type: 'query',
    hostId: 'local'
  })
  expect(received.allocations).toEqual([])
  expect(
    received.host.surfaces.filter((surface) => surface.content?.kind === 'agent-session')
  ).toEqual([])
  const terminal = received.host.surfaces.find((surface) => surface.content?.kind === 'terminal')!
  const leaf = terminal.content?.kind === 'terminal' ? terminal.content.leaves[leafId] : undefined
  expect(leaf?.facts.sleeping?.providerSession).toEqual({ key: 'session_id', id: 'wsl-resume' })
  expect(leaf?.facts.ptyId).toBeUndefined()
  expect(leaf?.facts.incarnationId).toBeUndefined()
  expect(leaf?.executorId).toBeUndefined()
  expect(leaf?.provenance).toBeUndefined()
  seedWslMoveCutover(
    sourceRoot,
    wslMoveCutoverFixture(
      'move-1',
      'destination-committed',
      {
        manifest: { ...exported.manifest, source: exported.manifest.source },
        manifestSha256: exported.manifest.manifestSha256
      },
      { repoIds: ['app'] }
    )
  )
  resetWslMoveDesktopRewriteStoresForTests()
  registerWslMoveMainRewriteStores(source)
  loadWslMoveFence(sourceRoot)
  const warn = vi.fn()
  await runWslMoveDesktopRewritePass({ userDataPath: sourceRoot, warn })
  const retention = await runWslMoveRetentionPass({ userDataPath: sourceRoot, store: source, warn })
  expect(warn).not.toHaveBeenCalled()
  expect(retention).not.toBeNull()
  expect(listWslMoveCutovers(sourceRoot)[0]?.phase).toBe('retained')
  const runtimeHost = toRuntimeExecutionHostId('wsl:Ubuntu')
  const assertSource = (store: Store) => {
    expect(
      store
        .readWorkspaceSurfaces()
        .some(
          (surface) =>
            surface.content?.kind === 'agent-session' && surface.content.sessionId === 'chat-local'
        )
    ).toBe(true)
    expect(store.getWorkspaceSession().tabsByWorktree[unrelated]).toHaveLength(1)
    const mirror = store.getWorkspaceSession(runtimeHost)
    expect(mirror.tabsByWorktree[onHost]).toHaveLength(1)
    expect(mirror.unifiedTabs?.[onHost]?.some((tab) => tab.contentType === 'agent-session')).toBe(
      false
    )
    expect(mirror.sleepingAgentSessionsByPaneKey?.[paneKey]?.worktreeId).toBe(onHost)
    expect(mirror.tabsByWorktree[unrelated]).toBeUndefined()
    expect(read(sourceInput).workspaceSurfaces.hosts.local.allocations).toContainEqual(debt)
  }
  assertSource(source)
  await closeTestJournalHostDatabase(sourceRoot)
  await Promise.all([source.freezeWritesAsync(), destination.freezeWritesAsync()])
  const sourceReopened = (await open(sourceInput)).store
  const destinationReopened = (await open(destinationInput)).store
  journal = await openTestJournalHostDatabase(sourceRoot)
  await installSurfaceNativeRuntimeOwner(journal, sourceReopened, 'local')
  assertSource(sourceReopened)
  expect(
    await journal.read((read) => read.prepare('SELECT session_id FROM agent_session_tabs').all())
  ).toContainEqual({ session_id: 'chat-local' })
  expect(destinationReopened.getWorkspaceSession().tabsByWorktree[onHost]).toHaveLength(1)
  expect(
    (await destinationReopened.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' }))
      .allocations
  ).toEqual([])
})
