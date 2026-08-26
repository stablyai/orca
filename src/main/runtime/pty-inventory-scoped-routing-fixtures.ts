import { vi, type Mock } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { OrcaRuntimeService } from './orca-runtime'
import {
  LOCAL_WORKTREE_ID,
  REPOS,
  RUNTIME_WORKTREE_ID,
  SSH_A_WORKTREE_ID,
  SSH_B_WORKTREE_ID,
  SSH_C_WORKTREE_ID,
  SSH_FOLDER,
  WSL_WORKTREE_ID,
  resolvedWorktree,
  type FolderFixture,
  type ListedSession,
  type ProjectGroupFixture,
  type ProviderKey,
  type RepoFixture,
  type ResolvedWorktreeFixture,
  type RuntimeInternals
} from './pty-inventory-scoped-routing-fixture-types'
export {
  LOCAL_WORKTREE_ID,
  RUNTIME_WORKTREE_ID,
  SSH_A_WORKTREE_ID,
  SSH_B_WORKTREE_ID,
  SSH_C_WORKTREE_ID,
  SSH_FOLDER,
  WSL_WORKTREE_ID,
  resolvedWorktree,
  type ProviderKey
} from './pty-inventory-scoped-routing-fixture-types'

type RoutingHarness = {
  runtime: OrcaRuntimeService
  internals: RuntimeInternals
  store: {
    getWorkspaceSession: Mock<() => ReturnType<typeof getDefaultWorkspaceSession>>
    getWorkspaceSessionHostIds: Mock<() => string[]>
    getFolderWorkspaces: Mock<() => FolderFixture[]>
    getProjectGroups: Mock<() => ProjectGroupFixture[]>
    getRepos: Mock<() => RepoFixture[]>
    getRepo: Mock<(id: string) => RepoFixture | undefined>
    getAllWorktreeMeta: Mock<() => Record<string, Record<string, unknown>>>
  }
  repos: RepoFixture[]
  session: ReturnType<typeof getDefaultWorkspaceSession>
  meta: Record<string, Record<string, unknown>>
  worktrees: ResolvedWorktreeFixture[]
  folderWorkspaces: FolderFixture[]
  projectGroups: ProjectGroupFixture[]
  kill: Mock<(ptyId: string) => boolean>
  spawn: Mock<() => Promise<{ id: string }>>
  sessions: Record<ProviderKey, ListedSession[]>
  failures: Set<ProviderKey>
  providers: Record<ProviderKey, Mock<() => Promise<ListedSession[]>>>
  listProcesses: Mock<(connectionId?: string | null, options?: unknown) => Promise<ListedSession[]>>
  listProcessesWithHostScope: Mock<() => Promise<{ processes: ListedSession[]; hostIds: string[] }>>
  clearProviderCalls: () => void
}

function createHarness(): RoutingHarness {
  const session = getDefaultWorkspaceSession()
  const repos = [...REPOS]
  const meta: Record<string, Record<string, unknown>> = {}
  const folderWorkspaces: FolderFixture[] = [SSH_FOLDER]
  const projectGroups: ProjectGroupFixture[] = []
  const worktrees = [
    resolvedWorktree(LOCAL_WORKTREE_ID, 'repo-local', '/local/project', 'local'),
    resolvedWorktree(WSL_WORKTREE_ID, 'repo-wsl', 'C:\\work\\project', 'local'),
    resolvedWorktree(SSH_A_WORKTREE_ID, 'repo-ssh-a', '/srv/a/project', 'ssh:box-a'),
    resolvedWorktree(SSH_B_WORKTREE_ID, 'repo-ssh-b', '/srv/b/project', 'ssh:box-b'),
    resolvedWorktree(SSH_C_WORKTREE_ID, 'repo-ssh-c', '/srv/c/project', 'ssh:box-c'),
    resolvedWorktree(
      RUNTIME_WORKTREE_ID,
      'repo-runtime',
      '/srv/runtime/project',
      'runtime:environment-1'
    )
  ]
  const store = {
    getWorkspaceSession: vi.fn(() => session),
    getWorkspaceSessionHostIds: vi.fn(() => [
      'local',
      'ssh:box-a',
      'ssh:box-b',
      'ssh:box-c',
      'runtime:environment-1'
    ]),
    getFolderWorkspaces: vi.fn(() => folderWorkspaces),
    getProjectGroups: vi.fn(() => projectGroups),
    getRepos: vi.fn(() => repos),
    getRepo: vi.fn((id: string) => repos.find((repo) => repo.id === id)),
    getAllWorktreeMeta: vi.fn(() => meta),
    getWorktreeMeta: vi.fn((worktreeId: string) => meta[worktreeId]),
    setWorktreeMeta: vi.fn((worktreeId: string, patch: Record<string, unknown>) => {
      meta[worktreeId] = { ...meta[worktreeId], ...patch }
      return meta[worktreeId]
    }),
    removeWorktreeMeta: vi.fn(),
    setWorkspaceSession: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
  const sessions: Record<ProviderKey, ListedSession[]> = {
    local: [],
    'box-a': [],
    'box-b': [],
    'box-c': []
  }
  const failures = new Set<ProviderKey>()
  const providers = {
    local: vi.fn(async () => sessions.local),
    'box-a': vi.fn(async () => {
      if (failures.has('box-a')) {
        throw new Error('box-a unavailable')
      }
      return sessions['box-a']
    }),
    'box-b': vi.fn(async () => {
      if (failures.has('box-b')) {
        throw new Error('box-b unavailable')
      }
      return sessions['box-b']
    }),
    'box-c': vi.fn(async () => {
      if (failures.has('box-c')) {
        throw new Error('box-c unavailable')
      }
      return sessions['box-c']
    })
  }
  const listProcesses = vi.fn(async (connectionId?: string | null) => {
    if (connectionId === null) {
      return await providers.local()
    }
    if (connectionId === 'box-a' || connectionId === 'box-b' || connectionId === 'box-c') {
      return await providers[connectionId]()
    }
    throw new Error(`unexpected aggregate fallback: ${String(connectionId)}`)
  })
  const kill = vi.fn(() => true)
  const listProcessesWithHostScope = vi.fn(async () => {
    const local = await providers.local()
    const remoteResults = await Promise.all(
      (['box-a', 'box-b', 'box-c'] as const).map(async (connectionId) => {
        try {
          return { connectionId, sessions: await providers[connectionId]() }
        } catch {
          return null
        }
      })
    )
    const available = remoteResults.filter((result) => result !== null)
    return {
      processes: [local, ...available.map((result) => result.sessions)].flat(),
      hostIds: ['local', ...available.map((result) => `ssh:${result.connectionId}`)]
    }
  })
  const spawn = vi.fn(async () => ({ id: 'never' }))
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill,
    hasPty: () => null,
    getForegroundProcess: async () => null,
    listProcesses,
    listProcessesWithHostScope
  } as never)
  const internals = runtime as unknown as RuntimeInternals
  internals.resolvedWorktreeCache = {
    worktrees,
    platformByRepoId: new Map(),
    expiresAt: Number.POSITIVE_INFINITY
  }

  const clearProviderCalls = () => {
    for (const provider of Object.values(providers)) {
      provider.mockClear()
    }
    listProcesses.mockClear()
    listProcessesWithHostScope.mockClear()
  }

  return {
    runtime,
    internals: runtime as unknown as RuntimeInternals,
    store,
    repos,
    session,
    meta,
    worktrees,
    folderWorkspaces,
    projectGroups,
    kill,
    spawn,
    sessions,
    failures,
    providers,
    listProcesses,
    listProcessesWithHostScope,
    clearProviderCalls
  }
}

export function makeHarness(): ReturnType<typeof createHarness> {
  return createHarness()
}
