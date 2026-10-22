import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import type { OrcadMigrationManifest } from '../../shared/orcad-migration/orcad-migration-manifest'
import {
  addManagedOrcadEnvironment,
  removeManagedOrcadEnvironment
} from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments, resolveEnvironment } from '../../shared/runtime-environment-store'
import type { Repo } from '../../shared/repo-types'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../shared/execution-host'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import type { OrcadMigrationDestinationCatalog } from './orcad-migration-cutover-coordinator'
import {
  listOrcadMigrationSourceCutovers,
  removeOrcadMigrationJournalsForDestination
} from './orcad-migration-cutover-journal'
import { planOrcadDeltaMove } from './orcad-migration-delta-plan'
import {
  linkedOrcadMigrationProjects,
  repositoriesHeldByServer,
  type OrcadServerRepository
} from './orcad-migration-repository-link'
import {
  folderWorkspacesHeldByServer,
  type OrcadServerFolderCatalog
} from './orcad-server-folder-workspaces'
import { reconcileManagedOrcadSshTargets, visibleRepos } from './orcad-retained-source'
import { SshConnectionStore } from './connection/ssh-connection-store'

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
  ensureOrcadManagedTunnel: mocks.ensureTunnel,
  closeOrcadManagedTunnel: async () => {}
}))

const { convertSshTargetToManagedOrcad } =
  await import('../managed-server/lifecycle/orcad-runtime-conversion')
const { runOrcadDeltaMove } = await import('./orcad-migration-delta-move')
const { runTargetLifecycle } = await import('../ipc/ssh/ssh-target-lifecycle-queue')

const TARGET: SshTarget = {
  id: 'ssh-shared',
  label: 'Shared box',
  host: 'box.example.com',
  port: 22,
  username: 'root',
  generation: 2
}
const onSsh = (id: string, targetId = TARGET.id) =>
  hostWorktreeTarget({ id, hostId: toSshExecutionHostId(targetId) })
const onServer = (id: string) => hostWorktreeTarget({ id, hostId: LOCAL_EXECUTION_HOST_ID })

function repo(id: string, path: string, connectionId: string | null = TARGET.id): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    ...(connectionId ? { connectionId } : {})
  }
}

let userDataPath: string
// This desktop's profile, which still holds the host's relay-era projects.
let store: Store
// The host's managed server, which another desktop on the same login already uses.
let server: Store
let targetStore: SshConnectionStore
let destination: OrcadMigrationDestinationCatalog & { stage: ReturnType<typeof vi.fn> }

/** The real server-side import behind the T6-9 calls, as orcad runs it. */
function serverDestination(): typeof destination {
  return {
    readState: async (manifest: OrcadMigrationManifest) =>
      server.getOrcadMigrationCatalogState(manifest),
    stage: vi.fn(async (manifest: OrcadMigrationManifest) =>
      server.stageOrcadMigrationCatalog(manifest)
    ),
    commit: async (manifest) => server.commitStagedOrcadMigrationCatalog(manifest),
    abort: async (manifest) => {
      const result = server.abortStagedOrcadMigrationCatalog(manifest)
      return result.aborted ? result : { ...result, durableAbsent: true as const }
    },
    abortByReference: vi.fn(),
    stageChunk: async (request) => server.stageOrcadMigrationSnapshotChunk(request)
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-repository-link-'))
  store = createSqliteTestStore(Store, {
    dataFile: join(userDataPath, 'desktop', 'orca-data.json')
  })
  server = createSqliteTestStore(Store, {
    dataFile: join(userDataPath, 'server', 'orca-data.json')
  })
  store.addSshTarget(TARGET)
  store.addRepo(repo('desktop-repo', '/root/migrepo'))
  store.addRepo(repo('desktop-only', '/root/tool'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SshConnectionStore wraps the real test store it is given.
  targetStore = new SshConnectionStore(store as never)
  mocks.state.targetStore = targetStore
  destination = serverDestination()
  mocks.ensureTunnel.mockImplementation(resolveEnvironment)
  mocks.deploy.mockImplementation(
    async (path: string, args: { name: string; sshTargetId: string }) => {
      const owner = getManagedOrcadFenceEnvironmentId(store.getSshTarget(args.sshTargetId))
      if (!owner) {
        throw new Error('deploy without a fence')
      }
      if (!listEnvironments(path).some((entry) => entry.id === owner)) {
        addManagedOrcadEnvironment(path, {
          id: owner,
          name: args.name,
          pairingCode: encodePairingOffer({
            v: PAIRING_OFFER_VERSION,
            endpoint: 'ws://127.0.0.1:46768/',
            deviceToken: 'device-token',
            publicKeyB64: 'public-key'
          }),
          orcadDeployment: {
            sshTargetId: args.sshTargetId,
            sshTargetGeneration: store.getSshTarget(args.sshTargetId)?.generation ?? 2,
            localPort: 46_768,
            remotePort: 6_768
          }
        })
      }
      // The running server of another Orca version, adopted as it is.
      return { outcome: 'already-current', environment: {}, activeVersion: '1.0.0' }
    }
  )
})

afterEach(async () => {
  await closeTestStores()
  rmSync(userDataPath, { recursive: true, force: true })
})

const convert = (
  link = true,
  census: 'exited' | 'unverifiable' = 'exited',
  sshTargetId = TARGET.id
) =>
  convertSshTargetToManagedOrcad(userDataPath, {
    sshTargetId,
    name: sshTargetId === TARGET.id ? 'Managed' : `Managed ${sshTargetId}`,
    censusHost: async () => ({ verdict: census, count: 0 }),
    destinationFor: () => destination,
    ...(link
      ? {
          serverRepositoriesFor: async () => server.getRepos(),
          serverFolderCatalogFor: async () => ({
            folderWorkspaces: server.getFolderWorkspaces(),
            projectGroups: server.getProjectGroups()
          })
        }
      : {}),
    now: () => new Date('2026-10-14T00:00:00.000Z')
  })

const serverRepoIds = () =>
  server
    .getRepos()
    .map((entry) => entry.id)
    .sort()

// Desktop A, on the same Unix login, added the same checkout.
const otherDesktopAddsSameCheckout = () =>
  server.addRepo(repo('server-repo', '/root/migrepo', null))

describe('moving onto a server another desktop already added the same project to', () => {
  it('is refused by the server when nothing links the project', async () => {
    otherDesktopAddsSameCheckout()
    await expect(convert(false)).rejects.toThrow(
      'orcad_migration_repository_path_conflict:/root/migrepo'
    )
  })

  it('links it to the server’s project and moves only what the server lacks', async () => {
    otherDesktopAddsSameCheckout()
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })

    expect(serverRepoIds()).toEqual(['desktop-only', 'server-repo'])
    const [journal] = listOrcadMigrationSourceCutovers(userDataPath)
    expect(journal).toMatchObject({
      phase: 'destination-committed',
      linkedRepositoryIds: ['desktop-repo'],
      sourceRetainedAt: '2026-10-14T00:00:00.000Z'
    })
    expect(journal?.manifest.payload.repositories.map((entry) => entry.id)).toEqual([
      'desktop-only'
    ])
    // Both rows stay for a downgraded build; this build shows the server's projects instead.
    expect(
      store
        .getRepos()
        .map((entry) => entry.id)
        .sort()
    ).toEqual(['desktop-only', 'desktop-repo'])
    expect(visibleRepos(store, () => userDataPath)).toEqual([])
  })

  it('tells the connect which projects it linked', async () => {
    otherDesktopAddsSameCheckout()
    await expect(convert()).resolves.toMatchObject({
      outcome: 'converted',
      linkedProjects: [{ path: '/root/migrepo', automations: 0 }]
    })
  })

  it.each([
    ['a connection id', { connectionId: 'nested-target' }],
    ['an SSH execution host', { executionHostId: 'ssh:nested-target' as const }],
    ['a runtime execution host', { executionHostId: 'runtime:other-env' as const }]
  ])(
    'imports, not links, when the server’s same-path project lives on another machine (%s)',
    async (_case, host) => {
      // A project another host holds, reached through the server's own SSH target.
      server.addRepo({ ...repo('nested-repo', '/root/migrepo', null), ...host })
      await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
      expect(serverRepoIds()).toEqual(['desktop-only', 'desktop-repo', 'nested-repo'])
      expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.linkedRepositoryIds).toBeUndefined()
    }
  )

  it('says nothing was linked when the server held none of the projects', async () => {
    const result = await convert()
    expect(result.outcome).toBe('converted')
    expect(result).not.toHaveProperty('linkedProjects')
  })

  it('leaves the linked project’s saved state to the server, moving only the rest', async () => {
    otherDesktopAddsSameCheckout()
    store.setWorktreeMeta(onSsh('desktop-repo::/root/migrepo'), { comment: 'from this desktop' })
    store.setWorktreeMeta(onSsh('desktop-only::/root/tool'), { comment: 'moves' })
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    expect(server.getWorktreeMeta('desktop-only::/root/tool')?.comment).toBe('moves')
    expect(server.getWorktreeMeta('desktop-repo::/root/migrepo')).toBeUndefined()
    // Kept in this desktop's retained rows for a downgraded build.
    expect(store.getWorktreeMeta('desktop-repo::/root/migrepo')?.comment).toBe('from this desktop')
  })

  // COMPAT(legacy-relay-bridge): the bridge reattaches a relay pane only into its own tab.
  describe('with a relay terminal the bridge still serves', () => {
    const lease = (worktreeId: string) => ({
      targetId: TARGET.id,
      ptyId: 'relay-pty',
      state: 'detached' as const,
      tabId: 'tab-1',
      worktreeId,
      createdAt: 1,
      updatedAt: 1
    })

    it('refuses to link the project the terminal runs in, naming it, and moves nothing', async () => {
      otherDesktopAddsSameCheckout()
      vi.spyOn(store, 'getSshRemotePtyLeases').mockReturnValue([
        lease('desktop-repo::/root/migrepo')
      ])
      await expect(convert(true, 'unverifiable')).rejects.toThrow(
        'orcad_migration_linked_project_terminals:/root/migrepo'
      )
      expect(serverRepoIds()).toEqual(['server-repo'])
      expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.linkedRepositoryIds).toBeUndefined()
    })

    it.each([
      ['no project', undefined],
      ['a project this desktop removed', 'removed-repo::/root/old']
    ])('refuses a terminal in %s without blaming the linked project', async (_case, worktreeId) => {
      otherDesktopAddsSameCheckout()
      const { worktreeId: _omit, ...unowned } = lease('')
      vi.spyOn(store, 'getSshRemotePtyLeases').mockReturnValue([
        worktreeId ? { ...unowned, worktreeId } : unowned
      ])
      await expect(convert(true, 'unverifiable')).rejects.toThrow(
        'orcad_migration_linked_project_unowned_terminals:/root/migrepo'
      )
      expect(serverRepoIds()).toEqual(['server-repo'])
    })

    it('still links when the terminal runs in a project that moves', async () => {
      otherDesktopAddsSameCheckout()
      vi.spyOn(store, 'getSshRemotePtyLeases').mockReturnValue([lease('desktop-only::/root/tool')])
      await expect(convert(true, 'unverifiable')).resolves.toMatchObject({ outcome: 'converted' })
      expect(serverRepoIds()).toEqual(['desktop-only', 'server-repo'])
    })
  })

  it('stays managed across a restart: the linked rows are not an older build’s change', async () => {
    otherDesktopAddsSameCheckout()
    await convert()
    reconcileManagedOrcadSshTargets(userDataPath, store)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
  })

  it('never offers the linked project again in a later delta move', async () => {
    otherDesktopAddsSameCheckout()
    await convert()
    store.addRepo(repo('added-later', '/root/later'))
    reconcileManagedOrcadSshTargets(userDataPath, store)
    const target = store.getSshTarget(TARGET.id)!
    expect(target.orcadFence?.sourceChangedAt).toBeDefined()
    const plan = planOrcadDeltaMove(userDataPath, store, target)
    expect(plan.added.map((row) => row.id)).toEqual(['added-later'])
  })

  it('re-journals a move the server already staged, after proving the stage is gone', async () => {
    destination.commit = async () => {
      throw new Error('socket closed')
    }
    await expect(convert()).rejects.toThrow('socket closed')
    const [staged] = listOrcadMigrationSourceCutovers(userDataPath)
    expect(staged?.phase).toBe('destination-staged')
    // Desktop A adds the same checkout while this move waits.
    otherDesktopAddsSameCheckout()
    destination = serverDestination()

    await expect(convert()).resolves.toMatchObject({
      outcome: 'converted',
      migrationId: staged?.migrationId
    })
    expect(serverRepoIds()).toEqual(['desktop-only', 'server-repo'])
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(1)
  })

  it('keeps refusing a source edited after the fence instead of linking over it', async () => {
    destination.stage.mockImplementationOnce(async () => {
      throw new Error('socket closed')
    })
    await expect(convert()).rejects.toThrow('socket closed')
    otherDesktopAddsSameCheckout()
    store.updateRepo(store.getRepo('desktop-only')!, { displayName: 'Renamed' })
    await expect(convert()).rejects.toThrow('orcad_migration_source_changed')
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.linkedRepositoryIds).toBeUndefined()
  })
})

// #29560: `orca environment stop` unlinks the server but leaves its profile on the host.
describe('moving the host again after its server was stopped', () => {
  // The local half of stop (unlinkEnvironmentLocally); the server keeps its profile.
  function stopServer(): void {
    const owner = getManagedOrcadFenceEnvironmentId(store.getSshTarget(TARGET.id))
    if (!owner) {
      throw new Error('no managed server to stop')
    }
    removeManagedOrcadEnvironment(userDataPath, owner)
    targetStore.getOrcadRuntimeClaims().release(TARGET.id, owner)
    removeOrcadMigrationJournalsForDestination(userDataPath, TARGET.id, owner)
  }

  it('links the projects the server kept from the first move instead of conflicting', async () => {
    store.setWorktreeMeta(onSsh('desktop-repo::/root/migrepo'), {
      comment: 'before the first move'
    })
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    // Used on the server while it was managed.
    server.setWorktreeMeta(onServer('desktop-repo::/root/migrepo'), {
      comment: 'edited on the server'
    })
    stopServer()

    await expect(convert()).resolves.toMatchObject({
      outcome: 'converted',
      linkedProjects: [
        { path: '/root/migrepo', automations: 0 },
        { path: '/root/tool', automations: 0 }
      ]
    })
    expect(serverRepoIds()).toEqual(['desktop-only', 'desktop-repo'])
    expect(server.getWorktreeMeta('desktop-repo::/root/migrepo')?.comment).toBe(
      'edited on the server'
    )
    expect(store.getWorktreeMeta('desktop-repo::/root/migrepo')?.comment).toBe(
      'before the first move'
    )
  })

  const targetGroup = (name: string, parentGroupId?: string) =>
    store.createProjectGroup({
      name,
      parentPath: '/root',
      ...(parentGroupId ? { parentGroupId } : {}),
      connectionId: TARGET.id,
      createdFrom: 'manual'
    })
  function groupDesktopRepo(): string {
    const group = store.createProjectGroup({
      name: 'Before',
      parentPath: '/root',
      connectionId: TARGET.id,
      createdFrom: 'manual'
    })
    store.moveProjectToGroup(store.getRepo('desktop-repo')!, group.id)
    return group.id
  }
  const groupName = (owner: Store, id: string) =>
    owner.getProjectGroups().find((entry) => entry.id === id)?.name
  // The delta move an older build's later edit asks for, against the real server store.
  const runDelta = () => {
    reconcileManagedOrcadSshTargets(userDataPath, store)
    return runOrcadDeltaMove({
      userDataPath,
      store,
      claims: targetStore.getOrcadRuntimeClaims(),
      target: store.getSshTarget(TARGET.id)!,
      environment: listEnvironments(userDataPath)[0]!,
      connectDestination: async () => destination,
      censusHost: async () => ({ verdict: 'exited', count: 0 }),
      runTargetLifecycle
    })
  }

  // Review repro: the linked project's retained group was imported over the server's renamed one.
  it('keeps the server’s project group when it changed while managed', async () => {
    const groupId = groupDesktopRepo()
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    server.updateProjectGroup(groupId, { name: 'Renamed on the server' })
    stopServer()

    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    expect(groupName(server, groupId)).toBe('Renamed on the server')
    expect(server.getRepo('desktop-repo')?.projectGroupId).toBe(groupId)
    // This desktop's retained copy stays as it was, for a downgraded build.
    expect(groupName(store, groupId)).toBe('Before')
  })

  it('moves a new project into a group the server holds in changed form', async () => {
    const groupId = groupDesktopRepo()
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    server.updateProjectGroup(groupId, { name: 'Renamed on the server' })
    stopServer()
    store.addRepo(repo('added-after-stop', '/root/later'))
    store.moveProjectToGroup(store.getRepo('added-after-stop')!, groupId)

    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    expect(server.getRepo('added-after-stop')?.projectGroupId).toBe(groupId)
    expect(groupName(server, groupId)).toBe('Renamed on the server')
  })

  it('never offers the server’s group again in a later delta move', async () => {
    const groupId = groupDesktopRepo()
    await convert()
    server.updateProjectGroup(groupId, { name: 'Renamed on the server' })
    stopServer()
    await convert()
    store.addRepo(repo('added-later', '/root/later'))
    reconcileManagedOrcadSshTargets(userDataPath, store)
    const target = store.getSshTarget(TARGET.id)!
    const plan = planOrcadDeltaMove(userDataPath, store, target)
    expect(plan.added.map((row) => row.id)).toEqual(['added-later'])
  })

  // Codex repro: a nested group's moved parent was re-exported in a later delta.
  it('keeps the server’s nested groups out of the relink and later deltas', async () => {
    const parent = store.createProjectGroup({
      name: 'Parent',
      parentPath: '/root',
      connectionId: TARGET.id,
      createdFrom: 'manual'
    })
    const child = store.createProjectGroup({
      name: 'Child',
      parentPath: '/root',
      parentGroupId: parent.id,
      connectionId: TARGET.id,
      createdFrom: 'manual'
    })
    store.moveProjectToGroup(store.getRepo('desktop-repo')!, child.id)
    await convert()
    server.updateProjectGroup(parent.id, { name: 'Parent renamed on the server' })
    stopServer()
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    expect(groupName(server, parent.id)).toBe('Parent renamed on the server')

    store.addRepo(repo('added-later', '/root/later'))
    await expect(runDelta()).resolves.toMatchObject({ outcome: 'moved' })
    expect(server.getRepo('added-later')).toBeDefined()
    expect(groupName(server, parent.id)).toBe('Parent renamed on the server')
  })

  // Codex repro: hiding the group from the source also hid the host a folder takes from it.
  it('still moves a later folder workspace that takes its host from the server’s group', async () => {
    const groupId = groupDesktopRepo()
    await convert()
    stopServer()
    await convert()
    const folder = store.createFolderWorkspace({
      projectGroupId: groupId,
      folderPath: '/root/notes'
    })
    await expect(runDelta()).resolves.toMatchObject({ outcome: 'moved' })
    expect(server.getFolderWorkspace(folder.id)?.projectGroupId).toBe(groupId)
  })

  // Codex repro: a group only a linked project used never reached the server, so it still moves.
  it('moves a linked project’s group the server does not hold, so later rows can use it', async () => {
    otherDesktopAddsSameCheckout()
    const groupId = groupDesktopRepo()
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    expect(groupName(server, groupId)).toBe('Before')
    store.addRepo(repo('added-later', '/root/later'))
    store.moveProjectToGroup(store.getRepo('added-later')!, groupId)
    await expect(runDelta()).resolves.toMatchObject({ outcome: 'moved' })
    expect(server.getRepo('added-later')?.projectGroupId).toBe(groupId)
  })

  // Review repro: a folder the server edited while managed must link on reconnect.
  it('links a folder workspace the server edited while managed', async () => {
    const group = targetGroup('Notes')
    const folder = store.createFolderWorkspace({
      projectGroupId: group.id,
      folderPath: '/root/notes'
    })
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    server.updateFolderWorkspace(folder.id, { comment: 'edited on the server' })
    stopServer()

    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    expect(server.getFolderWorkspace(folder.id)?.comment).toBe('edited on the server')
  })

  // Review repro: an empty group no server row sits in was re-imported over the server's.
  it('keeps the server’s empty project group when it was renamed while managed', async () => {
    const group = targetGroup('Empty')
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    server.updateProjectGroup(group.id, { name: 'Renamed on the server' })
    stopServer()

    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    expect(groupName(server, group.id)).toBe('Renamed on the server')
    expect(groupName(store, group.id)).toBe('Empty')
    store.addRepo(repo('added-later', '/root/later'))
    reconcileManagedOrcadSshTargets(userDataPath, store)
    const plan = planOrcadDeltaMove(userDataPath, store, store.getSshTarget(TARGET.id)!)
    expect(plan.added.map((row) => row.id)).toEqual(['added-later'])
  })

  it('keeps the server’s empty nested groups when their parent was renamed while managed', async () => {
    const parent = targetGroup('Parent')
    const child = targetGroup('Child', parent.id)
    await convert()
    server.updateProjectGroup(parent.id, { name: 'Parent renamed on the server' })
    stopServer()

    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    expect(groupName(server, parent.id)).toBe('Parent renamed on the server')
    expect(groupName(server, child.id)).toBe('Child')
  })

  it('does not link a same-id group the server keeps for another host', async () => {
    const group = targetGroup('Empty')
    await convert()
    server.updateProjectGroup(group.id, { name: 'Renamed on the server' })
    stopServer()
    const remoteCopy = server.getProjectGroups().find((entry) => entry.id === group.id)!
    // The server's row sits on one of its own SSH hosts, so it is not this desktop's group.
    const serverCatalog = async () => ({
      folderWorkspaces: [],
      projectGroups: [{ ...remoteCopy, connectionId: 'server-ssh-host' }]
    })
    await expect(
      convertSshTargetToManagedOrcad(userDataPath, {
        sshTargetId: TARGET.id,
        name: 'Managed',
        censusHost: async () => ({ verdict: 'exited', count: 0 }),
        destinationFor: () => destination,
        serverRepositoriesFor: async () => [],
        serverFolderCatalogFor: serverCatalog
      })
    ).rejects.toThrow(`orcad_migration_project_group_id_conflict:${group.id}`)
  })

  // Review repro: a later folder in the relinked group re-exported this desktop's old group.
  it('moves a later folder into the server’s renamed group without re-exporting it', async () => {
    const groupId = groupDesktopRepo()
    await convert()
    server.updateProjectGroup(groupId, { name: 'Renamed on the server' })
    stopServer()
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    const folder = store.createFolderWorkspace({
      projectGroupId: groupId,
      folderPath: '/root/notes'
    })
    await expect(runDelta()).resolves.toMatchObject({ outcome: 'moved' })
    expect(server.getFolderWorkspace(folder.id)?.projectGroupId).toBe(groupId)
    expect(groupName(server, groupId)).toBe('Renamed on the server')
  })

  // Opus repro: a group the first move imported, changed on the server, was re-exported too.
  it('moves a later row into a group the first move imported and the server changed', async () => {
    const groupId = groupDesktopRepo()
    await convert()
    server.updateProjectGroup(groupId, { name: 'Renamed on the server', isCollapsed: true })
    store.addRepo(repo('added-later', '/root/later'))
    store.moveProjectToGroup(store.getRepo('added-later')!, groupId)
    await expect(runDelta()).resolves.toMatchObject({ outcome: 'moved' })
    expect(server.getRepo('added-later')?.projectGroupId).toBe(groupId)
    expect(groupName(server, groupId)).toBe('Renamed on the server')
  })

  // The server's deletion stands: the move is refused whole and the host stays marked changed.
  it.each([
    ['linked', true],
    ['moved', false]
  ])(
    'refuses, without resurrecting it, a later row in a %s group the server deleted',
    async (_kind, relink) => {
      const groupId = groupDesktopRepo()
      await convert()
      if (relink) {
        stopServer()
        await convert()
      }
      server.moveProjectToGroup(server.getRepo('desktop-repo')!, null)
      server.deleteProjectGroup(groupId)
      store.addRepo(repo('added-later', '/root/later'))
      store.moveProjectToGroup(store.getRepo('added-later')!, groupId)
      await expect(runDelta()).resolves.toMatchObject({
        outcome: 'refused',
        code: 'orcad_delta_refused_by_server'
      })
      expect(server.getRepo('added-later')).toBeUndefined()
      expect(groupName(server, groupId)).toBeUndefined()
      expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
    }
  )

  it('resumes, not relinks, a move the server committed before the reply was lost', async () => {
    const commit = destination.commit
    destination.commit = async (manifest) => {
      await commit(manifest)
      throw new Error('socket closed')
    }
    await expect(convert()).rejects.toThrow('socket closed')
    const [pending] = listOrcadMigrationSourceCutovers(userDataPath)
    destination = serverDestination()

    const result = await convert()
    expect(result).toMatchObject({ outcome: 'converted', migrationId: pending?.migrationId })
    expect(result).not.toHaveProperty('linkedProjects')
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.linkedRepositoryIds).toBeUndefined()
  })
})

// #27285: the host's server kept the first move's projects; the desktop re-created the target.
describe('moving the host again after its SSH target was deleted and re-created', () => {
  function recreateTarget(): string {
    targetStore.removeTarget(TARGET.id)
    const { id: _id, generation: _generation, ...fields } = TARGET
    return targetStore.addTarget(fields).id
  }

  it('links the projects and saved state the server kept under the old target', async () => {
    store.setWorktreeMeta(onSsh('desktop-repo::/root/migrepo'), {
      comment: 'before the first move'
    })
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    server.setWorktreeMeta(onServer('desktop-repo::/root/migrepo'), {
      comment: 'edited on the server'
    })
    const recreated = recreateTarget()
    expect(store.getRepo('desktop-repo')?.connectionId).toBe(recreated)
    // Used on this desktop under the new target before it was moved again.
    store.setWorktreeMeta(onSsh('desktop-repo::/root/migrepo', recreated), {
      comment: 'edited after re-creating'
    })

    await expect(convert(true, 'exited', recreated)).resolves.toMatchObject({
      outcome: 'converted'
    })
    expect(serverRepoIds()).toEqual(['desktop-only', 'desktop-repo'])
    expect(server.getWorktreeMeta('desktop-repo::/root/migrepo')?.comment).toBe(
      'edited on the server'
    )
  })

  function folderInGroup(): { groupId: string; folderId: string } {
    const group = store.createProjectGroup({
      name: 'Notes',
      parentPath: '/root',
      connectionId: TARGET.id,
      createdFrom: 'manual'
    })
    const folder = store.createFolderWorkspace({
      projectGroupId: group.id,
      folderPath: '/root/notes'
    })
    return { groupId: group.id, folderId: folder.id }
  }

  it('links a folder workspace the server kept, though both sides edited it since', async () => {
    const { folderId } = folderInGroup()
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    server.updateFolderWorkspace(folderId, { comment: 'edited on the server' })
    const recreated = recreateTarget()
    store.updateFolderWorkspace(folderId, { comment: 'edited after re-creating' })

    await expect(convert(true, 'exited', recreated)).resolves.toMatchObject({
      outcome: 'converted',
      // The connect names it, since this desktop's tabs in it stay behind.
      linkedProjects: ['/root/migrepo', '/root/tool', '/root/notes'].map((path) => ({
        path,
        automations: 0
      }))
    })
    expect(server.getFolderWorkspace(folderId)?.comment).toBe('edited on the server')
    const journal = listOrcadMigrationSourceCutovers(userDataPath).find(
      (entry) => entry.sshTargetId === recreated
    )
    expect(journal?.linkedFolderWorkspaceIds).toEqual([folderId])
    expect(journal?.manifest.payload.folderWorkspaces).toEqual([])
    // This desktop's copy stays in its retained rows for a downgraded build.
    expect(store.getFolderWorkspace(folderId)?.comment).toBe('edited after re-creating')
  })

  // Codex repro: a folder lease key is `folder:<id>`, not a worktree id.
  describe('with relay terminals the bridge still serves', () => {
    const lease = (targetId: string, folderId: string) => ({
      targetId,
      ptyId: 'relay-pty',
      state: 'detached' as const,
      tabId: 'tab-1',
      worktreeId: `folder:${folderId}`,
      createdAt: 1,
      updatedAt: 1
    })

    it('still links when the terminal runs in a folder workspace that moves', async () => {
      const { groupId, folderId } = folderInGroup()
      await convert()
      const recreated = recreateTarget()
      const later = store.createFolderWorkspace({
        projectGroupId: groupId,
        folderPath: '/root/later'
      })
      vi.spyOn(store, 'getSshRemotePtyLeases').mockReturnValue([lease(recreated, later.id)])
      await expect(convert(true, 'unverifiable', recreated)).resolves.toMatchObject({
        outcome: 'converted'
      })
      expect(server.getFolderWorkspace(later.id)).toBeDefined()
      const journal = listOrcadMigrationSourceCutovers(userDataPath).find(
        (entry) => entry.sshTargetId === recreated
      )
      expect(journal?.linkedFolderWorkspaceIds).toEqual([folderId])
    })

    it('refuses to link the folder workspace the terminal runs in, naming it', async () => {
      const { folderId } = folderInGroup()
      await convert()
      const recreated = recreateTarget()
      vi.spyOn(store, 'getSshRemotePtyLeases').mockReturnValue([lease(recreated, folderId)])
      await expect(convert(true, 'unverifiable', recreated)).rejects.toThrow(
        'orcad_migration_linked_project_terminals:/root/notes'
      )
    })
  })

  it('never offers the linked folder workspace again in a later delta move', async () => {
    const { folderId } = folderInGroup()
    await convert()
    const recreated = recreateTarget()
    store.updateFolderWorkspace(folderId, { comment: 'edited after re-creating' })
    await convert(true, 'exited', recreated)
    store.addRepo(repo('added-later', '/root/later', recreated))
    reconcileManagedOrcadSshTargets(userDataPath, store)
    const target = store.getSshTarget(recreated)!
    expect(target.orcadFence?.sourceChangedAt).toBeDefined()
    const plan = planOrcadDeltaMove(userDataPath, store, target)
    expect(plan.added.map((row) => row.id)).toEqual(['added-later'])
  })
})

describe('what a linked project leaves behind', () => {
  it('counts this desktop’s automations on each linked project only', () => {
    const runIn = (repoId: string) => ({
      kind: 'workspace-run' as const,
      projectId: repoId,
      hostId: 'local' as const,
      projectHostSetupId: repoId,
      repoId,
      path: '/'
    })
    const fake = {
      getRepos: () => [repo('linked', '/root/app'), repo('moved', '/root/tool')],
      getFolderWorkspaces: () => [
        { id: 'notes', folderPath: '/root/notes' },
        { id: 'other-notes', folderPath: '/root/other' }
      ],
      listAutomations: () => [
        { projectId: 'linked' },
        { projectId: 'linked', runContext: runIn('moved') },
        { projectId: 'moved' },
        { projectId: 'other', runContext: runIn('linked') }
      ]
    }
    expect(linkedOrcadMigrationProjects(fake, { linkedRepositoryIds: ['linked'] })).toEqual([
      { path: '/root/app', automations: 2 }
    ])
    expect(linkedOrcadMigrationProjects(fake, { linkedFolderWorkspaceIds: ['notes'] })).toEqual([
      { path: '/root/notes', automations: 0 }
    ])
    expect(linkedOrcadMigrationProjects(fake, {})).toEqual([])
  })
})

describe('which projects are the same checkout', () => {
  const incoming = [{ id: 'mine', path: '/root/app' }]
  const NONE = { otherId: [], sameId: [] }

  it('links the same absolute path on the host, spelled with a trailing slash', () => {
    expect(repositoriesHeldByServer(incoming, [{ id: 'theirs', path: '/root/app/' }])).toEqual({
      otherId: ['mine'],
      sameId: []
    })
  })

  it('keeps a POSIX path that differs only in case apart', () => {
    expect(repositoriesHeldByServer(incoming, [{ id: 'theirs', path: '/root/App' }])).toEqual(NONE)
  })

  it('folds case on a Windows host', () => {
    expect(
      repositoriesHeldByServer(
        [{ id: 'mine', path: 'C:\\src\\app' }],
        [{ id: 'theirs', path: 'c:/src/app' }]
      )
    ).toEqual({ otherId: ['mine'], sameId: [] })
  })

  it('tells apart a project the server holds under the same id', () => {
    expect(repositoriesHeldByServer(incoming, [{ id: 'mine', path: '/root/app' }])).toEqual({
      otherId: [],
      sameId: ['mine']
    })
  })

  it('does not link a different path', () => {
    expect(repositoriesHeldByServer(incoming, [{ id: 'theirs', path: '/root/app2' }])).toEqual(NONE)
  })
})

describe('which folder workspaces the server already holds', () => {
  const incoming = [{ id: 'notes', folderPath: '/root/notes' }]
  const held = (
    row: Partial<OrcadServerFolderCatalog['folderWorkspaces'][number]>,
    serverRepos: OrcadServerRepository[] = [],
    group: Partial<OrcadServerFolderCatalog['projectGroups'][number]> = {}
  ) =>
    folderWorkspacesHeldByServer(
      incoming,
      {
        folderWorkspaces: [
          { id: 'notes', folderPath: '/root/notes/', projectGroupId: 'group', ...row }
        ],
        projectGroups: [{ id: 'group', parentGroupId: null, ...group }]
      },
      serverRepos
    )

  it('links the same id at the same folder', () => {
    expect(held({})).toEqual(['notes'])
  })

  it('keeps a same-id row at another folder apart, so the server refuses it', () => {
    expect(held({ folderPath: '/root/other' })).toEqual([])
  })

  it('keeps a same-path row under another id apart', () => {
    expect(held({ id: 'other' })).toEqual([])
  })

  it('keeps a row whose files are on another host apart', () => {
    expect(held({ connectionId: 'nested-target' })).toEqual([])
    expect(held({ executionHostId: 'ssh:nested-target' })).toEqual([])
    expect(held({}, [], { connectionId: 'nested-target' })).toEqual([])
  })

  // Codex repro: a bare row its group's nested SSH project places on another host.
  it('keeps a bare row apart when its group puts it on another host', () => {
    const nested = { id: 'r', path: '/srv/app', projectGroupId: 'group', connectionId: 'nested' }
    expect(held({}, [nested])).toEqual([])
    expect(held({}, [{ ...nested, connectionId: null }])).toEqual(['notes'])
  })
})
