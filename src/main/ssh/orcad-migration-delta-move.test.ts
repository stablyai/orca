import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { addManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments, resolveEnvironment } from '../../shared/runtime-environment-store'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson,
  writePersistedStateJson
} from '../persistence/persistence-test-harness'
import type { PersistedState } from '../../shared/persisted-state-types'
import { Store } from '../persistence/loading-store/store'
import {
  listOrcadMigrationCutoverChainForTarget,
  listOrcadMigrationSourceCutovers,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import { fakeOrcadMigrationDestination } from './orcad-migration-destination-fake'
import { keepOrcadServerVersion, runOrcadDeltaMove } from './orcad-migration-delta-move'
import { orcadSourceStoreWithout, planOrcadDeltaMove } from './orcad-migration-delta-plan'
import {
  createOrcadMigrationManifest,
  orcadMigrationCatalogIds
} from './orcad-migration-manifest-export'
import { latestOrcadMigrationInto } from './orcad-migration-rollback-mark'
import { MAX_ORCAD_MIGRATION_MANIFEST_BYTES } from '../../shared/orcad-migration/orcad-migration-manifest-validation'
import { retainOrcadMigrationSource } from './orcad-migration-source-retention'
import { reconcileManagedOrcadSshTargets, visibleRepos } from './orcad-retained-source'
import { SshConnectionStore } from './connection/ssh-connection-store'
import { resolveHostServerOnConnect } from './ssh-host-server-on-connect'
import { hostServerDepsStub } from './ssh-host-server-on-connect-test-deps'
import { runTargetLifecycle } from '../ipc/ssh/ssh-target-lifecycle-queue'

const mocks = vi.hoisted(() => {
  const state: { targetStore: unknown } = { targetStore: null }
  return { state, deploy: vi.fn(), ensureTunnel: vi.fn() }
})
vi.mock('./targets/ssh-target-registry', () => ({
  getSshConnectionManager: () => ({}),
  getSshTargetRegistryStore: () => mocks.state.targetStore
}))
vi.mock('../managed-server/lifecycle/orcad-runtime-deployment', () => ({
  createManagedOrcadEnvironment: mocks.deploy
}))
vi.mock('../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  ensureOrcadManagedTunnel: mocks.ensureTunnel
}))

const { convertSshTargetToManagedOrcad } =
  await import('../managed-server/lifecycle/orcad-runtime-conversion')

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 2
}

let userDataPath: string
let store: Store
let sshStore: SshConnectionStore
let destination: ReturnType<typeof fakeOrcadMigrationDestination>

function repo(id: string, path: string): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId: TARGET.id
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-delta-'))
  store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
  store.addSshTarget(TARGET)
  store.addRepo(repo('repo-1', '/srv/app'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SshConnectionStore wraps the real test store it is given.
  sshStore = new SshConnectionStore(store as never)
  mocks.state.targetStore = sshStore
  destination = fakeOrcadMigrationDestination()
  mocks.ensureTunnel.mockImplementation(resolveEnvironment)
  mocks.deploy.mockImplementation(async (path: string, args: { name: string }) => {
    const id = getManagedOrcadFenceEnvironmentId(store.getSshTarget(TARGET.id))!
    if (!listEnvironments(path).some((entry) => entry.id === id)) {
      addManagedOrcadEnvironment(path, {
        id,
        name: args.name,
        pairingCode: encodePairingOffer({
          v: PAIRING_OFFER_VERSION,
          endpoint: 'ws://127.0.0.1:46768/',
          deviceToken: 'device-token',
          publicKeyB64: 'public-key'
        }),
        orcadDeployment: {
          sshTargetId: TARGET.id,
          sshTargetGeneration: 2,
          localPort: 46_768,
          remotePort: 6_768
        }
      })
    }
    return { outcome: 'created', environment: {}, activeVersion: '1.0.0' }
  })
})

afterEach(async () => {
  await closeTestStores()
  rmSync(userDataPath, { recursive: true, force: true })
})

const now = () => new Date('2026-10-03T00:00:00.000Z')

/** Model an older build adding repo-2 and renaming retained repo-1 after conversion. */
async function convertedThenChangedOnOlderBuild(): Promise<void> {
  await expect(
    convertSshTargetToManagedOrcad(userDataPath, {
      sshTargetId: TARGET.id,
      name: 'Managed',
      censusHost: async () => ({ verdict: 'exited', count: 0 }),
      destinationFor: () => destination,
      now
    })
  ).resolves.toMatchObject({ outcome: 'converted' })
  store.addRepo(repo('repo-2', '/srv/tool'))
  store.updateRepo(store.getRepo('repo-1')!, { displayName: 'app-renamed' })
  reconcileManagedOrcadSshTargets(userDataPath, store, now)
  expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
}

function deltaMove(
  at: () => Date = now,
  census: 'exited' | 'live' = 'exited',
  connectDestination: () => Promise<typeof destination> = async () => destination
) {
  const target = store.getSshTarget(TARGET.id)!
  return runOrcadDeltaMove({
    userDataPath,
    store,
    claims: sshStore.getOrcadRuntimeClaims(),
    target,
    environment: listEnvironments(userDataPath)[0]!,
    connectDestination,
    censusHost: async () => ({ verdict: census, count: census === 'live' ? 1 : 0 }),
    runTargetLifecycle,
    now: at
  })
}

const LEAF = '11111111-1111-4111-8111-111111111111'

/** What v1.4.218 leaves after a downgrade: a terminal in what it added, and client focus there. */
async function olderBuildSessionAfterDowngrade(): Promise<void> {
  const hostId = `ssh:${TARGET.id}` as const
  const group = store.createProjectGroup({
    name: 'downgrade-added',
    parentPath: '/srv/folders',
    connectionId: TARGET.id,
    createdFrom: 'manual'
  })
  const folder = store.createFolderWorkspace({
    projectGroupId: group.id,
    name: 'downgrade-added workspace',
    folderPath: '/srv/folders/added',
    connectionId: TARGET.id
  })
  const folderKey = folderWorkspaceKey(folder.id)
  const environmentId = getManagedOrcadFenceEnvironmentId(store.getSshTarget(TARGET.id))!
  const focus: Partial<WorkspaceSessionState> = {
    activeRepoId: null,
    activeWorktreeId: folderKey,
    activeWorkspaceKey: folderKey,
    activeWorkspaceExecutionHostId: hostId,
    activeTabId: 'tab-term',
    activeConnectionIdsAtShutdown: [TARGET.id]
  }
  store.setWorkspaceSession({ ...store.getWorkspaceSession(), ...focus })
  store.setWorkspaceSession(
    {
      ...store.getWorkspaceSession(hostId),
      ...focus,
      tabsByWorktree: {
        [folderKey]: [
          {
            id: 'tab-term',
            ptyId: `${hostId}@@pty2:relay:1`,
            worktreeId: folderKey,
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-term': {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: `${hostId}@@pty2:relay:1` }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [`tab-term:${LEAF}`]: 'incarnation-1' },
      terminalTopologyRevisionByRepoId: { [folderKey]: 1 },
      activeWorktreeIdsOnShutdown: [folderKey],
      unifiedTabs: {
        // The managed build stamped repo-1's editor tab with its server before the downgrade.
        'repo-1::/srv/app': [
          {
            id: 'tab-editor',
            entityId: '/srv/app/README.md',
            groupId: 'group-editor',
            worktreeId: 'repo-1::/srv/app',
            executionHostId: `runtime:${environmentId}`,
            contentType: 'editor',
            label: 'README.md',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    },
    hostId
  )
  // Only the older build writes relay lease and consumer-recovery rows; this build loads them.
  await reopenWithOlderBuildRelayRows({
    sshRemotePtyLeases: [
      {
        targetId: TARGET.id,
        ptyId: 'pty2:relay:1',
        worktreeId: folderKey,
        tabId: 'tab-term',
        leafId: LEAF,
        state: 'expired',
        createdAt: 1,
        updatedAt: 1
      }
    ],
    sshPtyConsumerRecoveries: [
      {
        targetId: TARGET.id,
        clientInstanceId: 'client-1',
        serverBuildId: '0.1.0',
        clientGeneration: 1,
        ownerGeneration: 1,
        ownerLease: '9ab3f53d-0de9-4b80-af38-0cc15f62a6ba'
      }
    ]
  })
}

async function reopenWithOlderBuildRelayRows(rows: Partial<PersistedState>): Promise<void> {
  const dataFile = join(userDataPath, 'orca-data.json')
  await store.flushPendingOrThrowAsync()
  await store.freezeWritesAsync()
  const persisted = JSON.parse(readPersistedStateJson(dataFile))
  writePersistedStateJson(dataFile, JSON.stringify({ ...persisted, ...rows }))
  store = createSqliteTestStore(Store, { dataFile })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SshConnectionStore wraps the real test store it is given.
  sshStore = new SshConnectionStore(store as never)
  mocks.state.targetStore = sshStore
}

/** Lose both commit and later reads, as on a mid-commit tunnel drop. */
function loseContactAtDeltaCommit(): () => void {
  const read = destination.readState.getMockImplementation()!
  let lost = false
  destination.commit.mockImplementationOnce(async () => {
    lost = true
    throw new Error('socket closed')
  })
  destination.readState.mockImplementation(async (manifest) => {
    if (lost) {
      throw new Error('socket closed')
    }
    return read(manifest)
  })
  return () => {
    lost = false
  }
}

describe('moving what an older build added to a converted host', () => {
  it('previews additions and what the server keeps, then moves only the additions', async () => {
    await convertedThenChangedOnOlderBuild()
    const plan = planOrcadDeltaMove(userDataPath, store, store.getSshTarget(TARGET.id)!)
    expect(plan.added.map((row) => row.id)).toEqual(['repo-2'])
    expect(plan.notReflected.edited.map((row) => row.id)).toEqual(['repo-1'])
    expect(plan.notReflected.removed).toEqual([])

    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
    expect(destination.commits).toBe(2)
    const journals = listOrcadMigrationSourceCutovers(userDataPath)
    const [first, delta] = [...journals].sort((a) => (a.supersedesMigrationId ? 1 : -1))
    expect(delta?.supersedesMigrationId).toBe(first?.migrationId)
    expect(delta?.manifest.payload.repositories.map((row) => row.id)).toEqual(['repo-2'])
    expect(journals.every((journal) => journal.sourceRetainedAt)).toBe(true)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
    expect(visibleRepos(store, () => userDataPath)).toEqual([])
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
  })

  it('refuses, unjournaled, a delta under the export cap that no request can carry', async () => {
    await convertedThenChangedOnOlderBuild()
    const baseline = JSON.stringify(
      planOrcadDeltaMove(userDataPath, store, store.getSshTarget(TARGET.id)!).manifest
    ).length
    // Under the export cap, over the sealed-frame request budget: stage, state and abort all refuse.
    store.updateRepo(store.getRepo('repo-2')!, {
      displayName: 'x'.repeat(MAX_ORCAD_MIGRATION_MANIFEST_BYTES - 200 - baseline)
    })
    const plan = planOrcadDeltaMove(userDataPath, store, store.getSshTarget(TARGET.id)!)
    expect(JSON.stringify(plan.manifest).length).toBeLessThanOrEqual(
      MAX_ORCAD_MIGRATION_MANIFEST_BYTES
    )

    await expect(deltaMove()).rejects.toThrow(/\(orcad_migration_manifest_too_large\)$/)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(1)
    expect(destination.commits).toBe(1)
  })

  it('fails the whole delta when the server already holds a colliding row', async () => {
    await convertedThenChangedOnOlderBuild()
    destination.stage.mockRejectedValueOnce(
      new Error('orcad_migration_repository_id_conflict:repo-2')
    )
    await expect(deltaMove()).resolves.toMatchObject({
      outcome: 'refused',
      code: 'orcad_delta_refused_by_server',
      reason: 'orcad_migration_repository_id_conflict:repo-2'
    })
    expect(destination.commits).toBe(1)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(1)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
    expect(
      visibleRepos(store, () => userDataPath)
        .map((row) => row.id)
        .sort()
    ).toEqual(['repo-1', 'repo-2'])
  })

  it('keeps the server version: back to managed, the older build changes stay unshown', async () => {
    await convertedThenChangedOnOlderBuild()
    await keepOrcadServerVersion({
      userDataPath,
      store,
      claims: sshStore.getOrcadRuntimeClaims(),
      target: store.getSshTarget(TARGET.id)!
    })
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
    expect(visibleRepos(store, () => userDataPath)).toEqual([])
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
    expect(destination.commits).toBe(1)
  })

  it('survives a second downgrade and re-upgrade after the delta move', async () => {
    await convertedThenChangedOnOlderBuild()
    await deltaMove()
    // A second trip to an older build adds another project.
    store.addRepo(repo('repo-3', '/srv/docs'))
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
    const plan = planOrcadDeltaMove(userDataPath, store, store.getSshTarget(TARGET.id)!)
    expect(plan.added.map((row) => row.id)).toEqual(['repo-3'])
    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
    expect(destination.commits).toBe(3)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(3)
    expect(visibleRepos(store, () => userDataPath)).toEqual([])
  })

  it('moves what a downgrade added despite its exited terminal, tabs and client focus', async () => {
    await convertedThenChangedOnOlderBuild()
    await olderBuildSessionAfterDowngrade()
    expect(store.getSshRemotePtyLeases(TARGET.id)).toHaveLength(1)
    reconcileManagedOrcadSshTargets(userDataPath, store, now)

    const plan = planOrcadDeltaMove(userDataPath, store, store.getSshTarget(TARGET.id)!)
    expect(plan.blockers).toEqual([])
    expect(plan.added.map((row) => row.kind).sort()).toEqual([
      'folder-workspace',
      'project-group',
      'repository'
    ])
    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
    const delta = listOrcadMigrationSourceCutovers(userDataPath).find(
      (journal) => journal.supersedesMigrationId
    )
    const session = delta?.manifest.payload.dormantState?.workspaceSession
    expect(Object.values(session?.tabsByWorktree ?? {}).flat()).toMatchObject([
      { id: 'tab-term', ptyId: null }
    ])
    expect(session?.unifiedTabs?.['repo-1::/srv/app']).toBeUndefined()
  })

  // COMPAT(legacy-relay-bridge): a live relay terminal no longer blocks the move; the bridge keeps it.
  it('moves while a downgrade’s terminal still runs, leaving its lease to the bridge', async () => {
    await convertedThenChangedOnOlderBuild()
    await olderBuildSessionAfterDowngrade()
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    await expect(deltaMove(now, 'live')).resolves.toMatchObject({ outcome: 'moved' })
    const delta = listOrcadMigrationSourceCutovers(userDataPath).find(
      (journal) => journal.supersedesMigrationId
    )
    const [lease] = store.getSshRemotePtyLeases(TARGET.id)
    expect(delta).toMatchObject({ provenPtyIds: [], bridgedPtyIds: [lease.ptyId] })
    expect(lease.state).not.toBe('terminated')
  })

  it('commits through the destination the tunnel hands back once it opens', async () => {
    await convertedThenChangedOnOlderBuild()
    const opened: string[] = []
    // A re-pair while the tunnel opens: only the destination built after it can commit.
    const result = await deltaMove(now, 'exited', async () => {
      opened.push(listOrcadMigrationSourceCutovers(userDataPath).length === 2 ? 'journaled' : '?')
      return destination
    })
    expect(result).toMatchObject({ outcome: 'moved' })
    expect(opened).toEqual(['journaled'])
    expect(destination.commits).toBe(2)
  })

  it('keeps a delta journaled and the host marked when the tunnel cannot open', async () => {
    await convertedThenChangedOnOlderBuild()
    await expect(
      deltaMove(now, 'exited', async () => {
        throw new Error('ssh: connection reset')
      })
    ).rejects.toThrow('connection reset')
    expect(destination.commits).toBe(1)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(2)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
    expect(destination.commits).toBe(2)
  })

  it('resumes a delta whose commit lost contact, keeping the host marked meanwhile', async () => {
    await convertedThenChangedOnOlderBuild()
    const reconnect = loseContactAtDeltaCommit()
    await expect(deltaMove()).rejects.toThrow('socket closed')
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(2)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()

    reconnect()
    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
    expect(destination.commits).toBe(2)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(2)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
  })

  // Interrupted older deltas may include a moved group still referenced by their new row.
  it('resumes an older build’s interrupted delta that exported a moved group', async () => {
    const group = store.createProjectGroup({
      name: 'Apps',
      parentPath: '/srv',
      connectionId: TARGET.id,
      createdFrom: 'manual'
    })
    store.moveProjectToGroup(store.getRepo('repo-1')!, group.id)
    await convertedThenChangedOnOlderBuild()
    store.moveProjectToGroup(store.getRepo('repo-2')!, group.id)
    const reconnect = loseContactAtDeltaCommit()
    await expect(deltaMove()).rejects.toThrow('socket closed')
    const target = store.getSshTarget(TARGET.id)!
    const [first, delta] = listOrcadMigrationCutoverChainForTarget(userDataPath, TARGET.id)
    // The delta source an older build cut, which still exported every group a new row sits in.
    const olderSource = orcadSourceStoreWithout(
      store,
      target,
      orcadMigrationCatalogIds([first!.manifest.payload]),
      first!.destinationEnvironmentId
    )
    const manifest = createOrcadMigrationManifest(olderSource, target, {
      migrationId: delta!.migrationId,
      destinationEnvironmentId: delta!.destinationEnvironmentId,
      now: () => new Date(delta!.manifest.createdAt)
    })
    expect(manifest.payload.projectGroups.map((entry) => entry.id)).toEqual([group.id])
    writeOrcadMigrationSourceCutover(userDataPath, {
      ...delta!,
      manifest,
      manifestSha256: manifest.manifestSha256
    })

    reconnect()
    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
  })

  it('backs out an interrupted delta the source has since outgrown, then moves afresh', async () => {
    await convertedThenChangedOnOlderBuild()
    const reconnect = loseContactAtDeltaCommit()
    await expect(deltaMove()).rejects.toThrow('socket closed')
    reconnect()
    await expect(
      keepOrcadServerVersion({
        userDataPath,
        store,
        claims: sshStore.getOrcadRuntimeClaims(),
        target: store.getSshTarget(TARGET.id)!
      })
    ).rejects.toThrow('orcad_delta_move_unfinished')

    store.addRepo(repo('repo-3', '/srv/docs'))
    await expect(deltaMove()).resolves.toMatchObject({
      outcome: 'refused',
      reason: 'orcad_migration_source_changed'
    })
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(1)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
    expect(destination.commits).toBe(2)
  })

  it('refuses a delta whose source changes while it stages', async () => {
    await convertedThenChangedOnOlderBuild()
    const stage = destination.stage.getMockImplementation()!
    destination.stage.mockImplementationOnce(async (manifest) => {
      store.addRepo(repo('repo-3', '/srv/docs'))
      return stage(manifest)
    })
    await expect(deltaMove()).resolves.toMatchObject({
      outcome: 'refused',
      reason: 'orcad_migration_source_changed'
    })
    expect(destination.commits).toBe(1)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(1)
  })

  it('runs one of two concurrent moves; the other finds it superseded', async () => {
    await convertedThenChangedOnOlderBuild()
    const results = await Promise.all([deltaMove(), deltaMove()])
    expect(results.map((result) => result.outcome).sort()).toEqual(['moved', 'refused'])
    expect(destination.commits).toBe(2)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(2)
  })

  it('gives a delta a crash interrupted its mark back on the next start', async () => {
    await convertedThenChangedOnOlderBuild()
    const reconnect = loseContactAtDeltaCommit()
    await expect(deltaMove()).rejects.toThrow('socket closed')
    reconnect()
    // Model a crash after journal write but before the migration mark returned.
    const environmentId = store.getSshTarget(TARGET.id)!.orcadFence!.environmentId
    store.updateSshTarget(TARGET.id, { orcadFence: { environmentId } })
    expect(visibleRepos(store, () => userDataPath)).toHaveLength(2)
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
  })
})

const HOST_ID = `ssh:${TARGET.id}` as const

function saveDraft(worktreeId: string, content: string): void {
  store.setWorkspaceSession(
    {
      ...store.getWorkspaceSession(HOST_ID),
      openFilesByWorktree: {
        [worktreeId]: [
          {
            filePath: '/srv/notes.md',
            relativePath: 'notes.md',
            worktreeId,
            language: 'markdown',
            dirtyDraftContent: content
          }
        ]
      }
    },
    HOST_ID
  )
}

function savedDraft(worktreeId: string): string | undefined {
  return store.getWorkspaceSession(HOST_ID).openFilesByWorktree?.[worktreeId]?.[0]
    ?.dirtyDraftContent
}

async function convertKeepingSource(): Promise<void> {
  await expect(
    convertSshTargetToManagedOrcad(userDataPath, {
      sshTargetId: TARGET.id,
      name: 'Managed',
      censusHost: async () => ({ verdict: 'exited', count: 0 }),
      destinationFor: () => destination,
      now
    })
  ).resolves.toMatchObject({ outcome: 'converted' })
}

function retainedRows(): string {
  return JSON.stringify({
    repos: store.getRepos(),
    folderWorkspaces: store.getFolderWorkspaces(),
    projectGroups: store.getProjectGroups(),
    hostSession: store.getWorkspaceSession(HOST_ID),
    localSession: store.getWorkspaceSession()
  })
}

const expectAllRetained = () =>
  expect(listOrcadMigrationSourceCutovers(userDataPath).every((j) => j.sourceRetainedAt)).toBe(true)

/** Committed connects retain source rows without a retirement step. */
async function connectAgain(): Promise<void> {
  const target = store.getSshTarget(TARGET.id)!
  const environmentId = target.orcadFence!.environmentId
  await resolveHostServerOnConnect(target, {
    ...hostServerDepsStub(),
    managedEnvironmentId: () => environmentId,
    retainCommittedSource: async (host) => {
      const head = listOrcadMigrationSourceCutovers(userDataPath).find(
        (journal) => journal.sshTargetId === host.id && !journal.sourceRetainedAt
      )
      if (head?.phase === 'destination-committed') {
        await retainOrcadMigrationSource(userDataPath, head.migrationId, store, now)
      }
    }
  })
}

/** Reopen profile and journals from disk to model restart. */
async function restart(): Promise<void> {
  await store.flushPendingOrThrowAsync()
  await closeTestStores()
  store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SshConnectionStore wraps the real test store it is given.
  sshStore = new SshConnectionStore(store as never)
  mocks.state.targetStore = sshStore
  reconcileManagedOrcadSshTargets(userDataPath, store, now)
}

describe('a retained source is never deleted', () => {
  it.each([
    ['a repository worktree', () => 'repo-1::/srv/app'],
    [
      'a folder workspace on a folder-only host',
      () => {
        store.removeProjectForHost({ id: 'repo-1', executionHostId: `ssh:${TARGET.id}` })
        const group = store.createProjectGroup({
          name: 'folders',
          parentPath: '/srv/folders',
          connectionId: TARGET.id,
          createdFrom: 'manual'
        })
        const folder = store.createFolderWorkspace({
          projectGroupId: group.id,
          folderPath: '/srv/folders/notes',
          connectionId: TARGET.id
        })
        return folderWorkspaceKey(folder.id)
      }
    ]
  ])('in %s, across connects and a restart', async (_label, workspace) => {
    const worktreeId = workspace()
    saveDraft(worktreeId, 'draft before migration')
    await convertKeepingSource()
    // A reload only fills defaults; the snapshot is taken as stored.
    await restart()
    const kept = retainedRows()

    await connectAgain()
    expect(retainedRows()).toBe(kept)
    await restart()
    await connectAgain()
    expect(retainedRows()).toBe(kept)
    expect(savedDraft(worktreeId)).toBe('draft before migration')
    expectAllRetained()
  })

  // Identity changes mark the source changed; edits inside moved projects remain retained only.
  it('keeps an older build’s draft edit without marking the host changed', async () => {
    saveDraft('repo-1::/srv/app', 'draft before migration')
    await convertKeepingSource()
    saveDraft('repo-1::/srv/app', 'draft after downgrade')
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()

    await connectAgain()
    await restart()
    await connectAgain()
    expect(savedDraft('repo-1::/srv/app')).toBe('draft after downgrade')
    expectAllRetained()
  })

  it('keeps every row through a delta move and through keeping the server version', async () => {
    await convertedThenChangedOnOlderBuild()
    await restart()
    const kept = retainedRows()
    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
    expect(retainedRows()).toBe(kept)
    await restart()
    await connectAgain()
    expect(retainedRows()).toBe(kept)

    store.addRepo(repo('repo-3', '/srv/docs'))
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    const changed = retainedRows()
    await keepOrcadServerVersion({
      userDataPath,
      store,
      claims: sshStore.getOrcadRuntimeClaims(),
      target: store.getSshTarget(TARGET.id)!
    })
    expect(retainedRows()).toBe(changed)
    await restart()
    await connectAgain()
    expect(retainedRows()).toBe(changed)
    expectAllRetained()
  })
})

describe('a delta move against a rollback of an update taken before it', () => {
  const later = () => new Date('2026-10-05T00:00:00.000Z')
  // An update activated after the conversion and before the delta: its snapshot lacks the delta.
  const updateActivatedAt = Date.parse('2026-10-04T00:00:00.000Z')
  const rollbackCrossesMigration = () =>
    updateActivatedAt <
    Date.parse(latestOrcadMigrationInto(userDataPath, listEnvironments(userDataPath)[0]!) ?? '')

  it('marks the server before the delta commits, so the rollback is refused', async () => {
    await convertedThenChangedOnOlderBuild()
    expect(rollbackCrossesMigration()).toBe(false)
    const commit = destination.commit.getMockImplementation()!
    destination.commit.mockImplementationOnce(async (manifest) => {
      expect(listEnvironments(userDataPath)[0]?.orcadMigratedAt).toBe(later().toISOString())
      return commit(manifest)
    })
    await expect(deltaMove(later)).resolves.toMatchObject({ outcome: 'moved' })
    expect(rollbackCrossesMigration()).toBe(true)
  })

  it('keeps the mark when the commit lands but its reply is lost', async () => {
    await convertedThenChangedOnOlderBuild()
    const commit = destination.commit.getMockImplementation()!
    const read = destination.readState.getMockImplementation()!
    let lost = false
    destination.commit.mockImplementationOnce(async (manifest) => {
      await commit(manifest)
      lost = true
      throw new Error('socket closed')
    })
    destination.readState.mockImplementation(async (manifest) => {
      if (lost) {
        throw new Error('socket closed')
      }
      return read(manifest)
    })
    await expect(deltaMove(later)).rejects.toThrow('socket closed')
    expect(destination.commits).toBe(2)
    expect(rollbackCrossesMigration()).toBe(true)
  })

  it('protects a folder-only delta the same way', async () => {
    await convertedThenChangedOnOlderBuild()
    store.removeProjectForHost({ id: 'repo-2', executionHostId: `ssh:${TARGET.id}` })
    const group = store.createProjectGroup({
      name: 'folders',
      parentPath: '/srv/folders',
      connectionId: TARGET.id,
      createdFrom: 'manual'
    })
    store.createFolderWorkspace({
      projectGroupId: group.id,
      folderPath: '/srv/folders/notes',
      connectionId: TARGET.id
    })
    const plan = planOrcadDeltaMove(userDataPath, store, store.getSshTarget(TARGET.id)!)
    expect(plan.added.map((row) => row.kind).sort()).toEqual(['folder-workspace', 'project-group'])
    await expect(deltaMove(later)).resolves.toMatchObject({ outcome: 'moved' })
    expect(rollbackCrossesMigration()).toBe(true)
  })
})
