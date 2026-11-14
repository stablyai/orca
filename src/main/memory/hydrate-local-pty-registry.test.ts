import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { SessionInfo } from '../daemon/protocol/daemon-session-info'
import type { DaemonPtyAdapter } from '../daemon/providers/adapter/daemon-pty-adapter'
import type { Store } from '../persistence/loading-store/store'
import type { hydrateLocalPtyRegistryAtBoot as HydrateFn } from './hydrate-local-pty-registry'
import type {
  listRegisteredPtys as ListFn,
  registerPty as RegisterFn,
  unregisterPty as UnregisterFn
} from './pty-registry'
const getDaemonProviderMock = vi.fn()
vi.mock('../daemon/providers/lifecycle/daemon-provider-state', () => ({
  getDaemonProvider: () => getDaemonProviderMock()
}))

// Adapter routing uses instanceof; the mock class must survive resetModules.
const { FakeDaemonPtyRouter } = vi.hoisted(() => ({
  FakeDaemonPtyRouter: class {
    constructor(private readonly adapters: unknown[]) {}
    getAllAdapters(): unknown[] {
      return this.adapters
    }
  }
}))
vi.mock('../daemon/providers/routing/daemon-pty-router', () => ({
  DaemonPtyRouter: FakeDaemonPtyRouter
}))

const getLocalProjectWorktreeGitOptionsMock = vi.fn()
vi.mock('../workspaces/execution-host/project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: (store: unknown, repo: unknown) =>
    getLocalProjectWorktreeGitOptionsMock(store, repo)
}))

const listLocalRepoWorktreesStrictMock = vi.fn()
vi.mock('../workspaces/catalog/repo-worktrees', () => ({
  listLocalRepoWorktreesStrict: (
    repo: unknown,
    options?: { signal?: AbortSignal; wslDistro?: string }
  ) => listLocalRepoWorktreesStrictMock(repo, options)
}))

function makeStore(
  repos: {
    id: string
    connectionId?: string | null
    executionHostId?: Repo['executionHostId']
    kind?: Repo['kind']
    path?: string
  }[] = [],
  worktreeMeta: Record<string, WorktreeMeta> = {},
  folderWorkspaces: FolderWorkspace[] = []
): Store {
  const built: Repo[] = repos.map((r) => ({
    id: r.id,
    path: r.path ?? `/tmp/${r.id}`,
    displayName: r.id,
    badgeColor: '#000000',
    addedAt: 0,
    connectionId: r.connectionId ?? null,
    executionHostId: r.executionHostId ?? null,
    kind: r.kind
  }))
  const store: Partial<Store> = {
    getRepos: () => built,
    getFolderWorkspaces: () => folderWorkspaces,
    getProjectGroups: () => [],
    getAllWorktreeMeta: () => worktreeMeta,
    getAllWorktreeMetaForHost: (hostId) =>
      Object.fromEntries(
        Object.entries(worktreeMeta).filter(([, meta]) => !meta.hostId || meta.hostId === hostId)
      )
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hydration reads only the store members stubbed above.
  return store as Store
}

function makeProvider(sessions: SessionInfo[]): Pick<DaemonPtyAdapter, 'listSessions'> {
  return {
    listSessions: vi.fn().mockResolvedValue(sessions)
  }
}

// Reload hydration and its module-scoped registry together so both use the same Map.
async function loadFresh(): Promise<{
  hydrate: typeof HydrateFn
  deadlineMs: number
  gitEnumerationConcurrency: number
  listRegisteredPtys: typeof ListFn
  registerPty: typeof RegisterFn
  unregisterPty: typeof UnregisterFn
}> {
  vi.resetModules()
  const hydrateMod = await import('./hydrate-local-pty-registry')
  const registryMod = await import('./pty-registry')
  return {
    hydrate: hydrateMod.hydrateLocalPtyRegistryAtBoot,
    deadlineMs: hydrateMod.LOCAL_PTY_REGISTRY_BOOT_HYDRATION_DEADLINE_MS,
    gitEnumerationConcurrency: hydrateMod.LOCAL_PTY_REGISTRY_GIT_ENUMERATION_CONCURRENCY,
    listRegisteredPtys: registryMod.listRegisteredPtys,
    registerPty: registryMod.registerPty,
    unregisterPty: registryMod.unregisterPty
  }
}

describe('hydrateLocalPtyRegistryAtBoot', () => {
  beforeEach(() => {
    getDaemonProviderMock.mockReset()
    getLocalProjectWorktreeGitOptionsMock.mockReset().mockReturnValue({})
    listLocalRepoWorktreesStrictMock.mockReset()
  })

  it('fails closed when live worktrees collide on one normalized key', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    const ptyId = 'repo-a::C:/Users/Neil/Orca@@cafebabe'
    getDaemonProviderMock.mockReturnValue(
      makeProvider([
        { sessionId: ptyId, pid: 4242, cwd: 'C:/Users/Neil/Orca' } as unknown as SessionInfo
      ])
    )
    listLocalRepoWorktreesStrictMock.mockResolvedValue([
      {
        path: 'C:/Users/Neil/Orca',
        head: '',
        branch: '',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: 'c:\\users\\neil\\orca',
        head: '',
        branch: '',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await hydrate(makeStore([{ id: 'repo-a', path: 'C:/Users/Neil/Orca' }]))

    expect(listRegisteredPtys()).toHaveLength(0)
  })

  it('rejects legacy folder-instance metadata when the repo id also has a remote owner', async () => {
    const { hydrate, listRegisteredPtys } = await loadFresh()
    const instanceId =
      'folder-repo::/workspace/folder::workspace:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    getDaemonProviderMock.mockReturnValue(
      makeProvider([
        {
          sessionId: `${instanceId}@@cafebabe`,
          pid: 4242,
          cwd: '/workspace/folder'
        } as unknown as SessionInfo
      ])
    )

    await hydrate(
      makeStore(
        [
          { id: 'folder-repo', kind: 'folder', path: '/workspace/folder' },
          {
            id: 'folder-repo',
            kind: 'folder',
            path: '/workspace/folder',
            executionHostId: 'runtime:environment-1'
          }
        ],
        { [instanceId]: {} as WorktreeMeta }
      )
    )

    expect(listRegisteredPtys()).toHaveLength(0)
  })
})
