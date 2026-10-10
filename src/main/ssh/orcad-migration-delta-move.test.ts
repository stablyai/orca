import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { addManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { listOrcadMigrationSourceCutovers } from './orcad-migration-cutover-journal'
import { fakeOrcadMigrationDestination } from './orcad-migration-destination-fake'
import { keepOrcadServerVersion, runOrcadDeltaMove } from './orcad-migration-delta-move'
import { planOrcadDeltaMove } from './orcad-migration-delta-plan'
import { latestOrcadMigrationInto } from './orcad-migration-rollback-mark'
import { retainOrcadMigrationSource } from './orcad-migration-source-retention'
import { reconcileManagedOrcadSshTargets, visibleRepos } from './orcad-retained-source'
import { SshConnectionStore } from './ssh-connection-store'
import { resolveHostServerOnConnect } from './ssh-host-server-on-connect'
import { hostServerDepsStub } from './ssh-host-server-on-connect-test-deps'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'

const mocks = vi.hoisted(() => {
  const state: { targetStore: unknown } = { targetStore: null }
  return { state, deploy: vi.fn(), ensureTunnel: vi.fn() }
})
vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: () => ({}),
  getSshTargetRegistryStore: () => mocks.state.targetStore,
  hasRegisteredDirectSshAuthority: () => false
}))
vi.mock('./orcad-runtime-deployment', () => ({ createManagedOrcadEnvironment: mocks.deploy }))
vi.mock('./orcad-managed-tunnel', () => ({ ensureOrcadManagedTunnel: mocks.ensureTunnel }))

const { convertSshTargetToManagedOrcad } = await import('./orcad-runtime-conversion')

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
  mocks.ensureTunnel.mockResolvedValue(undefined)
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

/** Converted with source retirement off, then an older build adds repo-2 and renames repo-1. */
async function convertedThenChangedOnOlderBuild(): Promise<void> {
  await expect(
    convertSshTargetToManagedOrcad(userDataPath, {
      sshTargetId: TARGET.id,
      name: 'Managed',
      listRelayPtyIds: Object.assign(async () => [], { previous: async () => [] }),
      censusHost: async () => ({ verdict: 'exited', count: 0 }),
      destinationFor: () => destination,
      releaseDirectSession: async () => {},
      now
    })
  ).resolves.toMatchObject({ outcome: 'converted' })
  store.addRepo(repo('repo-2', '/srv/tool'))
  store.updateRepo('repo-1', { displayName: 'app-renamed' })
  reconcileManagedOrcadSshTargets(userDataPath, store, now)
  expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
}

function deltaMove(at: () => Date = now) {
  const target = store.getSshTarget(TARGET.id)!
  return runOrcadDeltaMove({
    userDataPath,
    store,
    claims: sshStore.getOrcadRuntimeClaims(),
    target,
    environment: listEnvironments(userDataPath)[0]!,
    destination,
    // This relay and every earlier-build relay answer that nothing runs.
    listRelayPtyIds: Object.assign(async () => [], { previous: async () => [] }),
    censusHost: async () => ({ verdict: 'exited', count: 0 }),
    releaseDirectSession: async () => {},
    ensureTunnel: async () => {},
    runTargetLifecycle,
    now: at
  })
}

const LEAF = '11111111-1111-4111-8111-111111111111'

/** What v1.4.218 leaves after a downgrade: a terminal in what it added, and client focus there. */
function olderBuildSessionAfterDowngrade(): void {
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
  store.upsertSshRemotePtyLease({
    targetId: TARGET.id,
    ptyId: 'pty2:relay:1',
    worktreeId: folderKey,
    tabId: 'tab-term',
    leafId: LEAF,
    state: 'expired'
  })
}

/** The delta's commit and every read after it fail, as when the tunnel drops mid-commit. */
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
    // Back to managed, and a start with nothing new keeps it there.
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
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
    olderBuildSessionAfterDowngrade()
    await store.upsertSshPtyConsumerRecovery({
      targetId: TARGET.id,
      clientInstanceId: 'client-1',
      serverBuildId: '0.1.0',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'lease'
    })
    reconcileManagedOrcadSshTargets(userDataPath, store, now)

    const plan = planOrcadDeltaMove(userDataPath, store, store.getSshTarget(TARGET.id)!)
    expect(plan.blockers).toEqual([])
    expect(plan.added.map((row) => row.kind).sort()).toEqual([
      'folder-workspace',
      'project-group',
      'repository'
    ])
    // The relay answers with no terminals, so the expired lease is proven exited.
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
    // What a crash before the mark came back leaves: the delta journal, a fence without its mark.
    const environmentId = store.getSshTarget(TARGET.id)!.orcadFence!.environmentId
    store.updateSshTarget(TARGET.id, { orcadFence: { environmentId } })
    expect(visibleRepos(store, () => userDataPath)).toHaveLength(2)
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
  })
})

const HOST_ID = `ssh:${TARGET.id}` as const

/** An unsaved editor draft in the host's session partition, as either build would save it. */
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
      listRelayPtyIds: Object.assign(async () => [], { previous: async () => [] }),
      censusHost: async () => ({ verdict: 'exited', count: 0 }),
      destinationFor: () => destination,
      releaseDirectSession: async () => {},
      now
    })
  ).resolves.toMatchObject({ outcome: 'converted' })
}

/** Everything of the host's that this build keeps for a downgrade, as stored. */
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

/** What a connect does with a committed head; there is no retirement step any more. */
async function connectAgain(): Promise<void> {
  const target = store.getSshTarget(TARGET.id)!
  const environmentId = target.orcadFence!.environmentId
  await resolveHostServerOnConnect(target, {
    ...hostServerDepsStub(),
    managedEnvironmentId: () => environmentId,
    retainCommittedSource: (host) => {
      const head = listOrcadMigrationSourceCutovers(userDataPath).find(
        (journal) => journal.sshTargetId === host.id && !journal.sourceRetainedAt
      )
      if (head?.phase === 'destination-committed') {
        retainOrcadMigrationSource(userDataPath, head.migrationId, now)
      }
    }
  })
}

/** A restart: the profile and journals are re-read from disk by a fresh store. */
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
        store.removeProjectForHost('repo-1', `ssh:${TARGET.id}`)
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

  // The trade-off: identity drives "changed", so an edit inside a moved project only stays kept.
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
    store.removeProjectForHost('repo-2', `ssh:${TARGET.id}`)
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
