import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { DEFAULT_WORKTREE_LIST_LIMIT, DEFAULT_WORKTREE_PS_LIMIT } from './orca-runtime-postlude'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'

const LOCAL_REPO_ID = 'repo-local'
const SSH_REPO_ID = 'repo-ssh'
const SSH_HOST_ID = 'ssh:box-1'
// Round-robin with local-first host order leaves SSH with zero rows at this cap.
const LIMIT_EXCLUDING_SSH_HOST = 1

const REPOS = [
  {
    id: LOCAL_REPO_ID,
    path: '/tmp/local-worktree',
    displayName: 'local',
    badgeColor: '#000000',
    addedAt: 0
  },
  {
    id: SSH_REPO_ID,
    path: '/remote/ssh-worktree',
    displayName: 'ssh',
    badgeColor: '#000000',
    addedAt: 0,
    connectionId: 'box-1'
  }
]

type TestResolvedWorktree = {
  id: string
  repoId: string
  path: string
  branch: string
  displayName: string
  hostId: 'local' | 'ssh:box-1'
  isArchived: boolean
  isMainWorktree: boolean
  linkedIssue: null
  parentWorktreeId: null
  childWorktreeIds: []
  lineage: null
  git: GitWorktreeInfo
}

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    getWorkspaceSessionHostIds: vi.fn(() => ['local', SSH_HOST_ID]),
    getFolderWorkspaces: vi.fn(() => []),
    getProjectGroups: vi.fn(() => []),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => REPOS),
    getRepo: vi.fn((id: string) => REPOS.find((repo) => repo.id === id)),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => []),
    getAllWorktreeLineage: vi.fn(() => ({}))
  }
}

function resolvedWorktree(
  repoId: string,
  path: string,
  hostId: 'local' | 'ssh:box-1'
): TestResolvedWorktree {
  const id = `${repoId}::${path}`
  return {
    id,
    repoId,
    path,
    branch: 'main',
    displayName: path,
    hostId,
    isArchived: false,
    isMainWorktree: true,
    linkedIssue: null,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: { path, head: 'abc123', branch: 'refs/heads/main', isBare: false, isMainWorktree: true }
  }
}

function qaReproCatalog(): TestResolvedWorktree[] {
  const localRows = Array.from({ length: 434 }, (_, index) =>
    resolvedWorktree(LOCAL_REPO_ID, `/aaa/local-${index}`, 'local')
  )
  const sshRows = Array.from({ length: 23 }, (_, index) =>
    resolvedWorktree(SSH_REPO_ID, `/zzz/ssh-${index}`, SSH_HOST_ID)
  )
  return [...localRows, ...sshRows]
}

function mockListResolvedWorktrees(runtime: OrcaRuntimeService, worktrees: TestResolvedWorktree[]) {
  vi.spyOn(
    runtime as unknown as { listResolvedWorktrees: () => Promise<TestResolvedWorktree[]> },
    'listResolvedWorktrees'
  ).mockResolvedValue(worktrees)
}

function mockListResolvedWorktreeSnapshot(
  runtime: OrcaRuntimeService,
  worktrees: TestResolvedWorktree[]
) {
  vi.spyOn(
    runtime as unknown as {
      listResolvedWorktreeSnapshot: () => Promise<{
        worktrees: TestResolvedWorktree[]
        platformByRepoId: Map<string, 'linux'>
      }>
    },
    'listResolvedWorktreeSnapshot'
  ).mockResolvedValue({
    worktrees,
    platformByRepoId: new Map([
      [LOCAL_REPO_ID, 'linux'],
      [SSH_REPO_ID, 'linux']
    ])
  })
}

function mockPtyControllerWithHostScope(runtime: OrcaRuntimeService) {
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses: vi.fn(async () => []),
    listProcessesWithHostScope: vi.fn(async () => ({
      processes: [],
      hostIds: ['local', SSH_HOST_ID]
    }))
  } as never)
}

describe('listManagedWorktrees host scope', () => {
  it('includes SSH rows at the default limit when local worktrees dominate', async () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)
    mockListResolvedWorktrees(runtime, qaReproCatalog())

    const result = await runtime.listManagedWorktrees()

    expect(result.truncated).toBe(true)
    expect(result.totalCount).toBe(457)
    expect(result.worktrees.length).toBe(DEFAULT_WORKTREE_LIST_LIMIT)
    expect(result.worktrees.some((worktree) => worktree.hostId === SSH_HOST_ID)).toBe(true)
    expect(result.worktrees.filter((worktree) => worktree.hostId === SSH_HOST_ID).length).toBe(23)
    expect(result.hostScope?.hostIds).toEqual(expect.arrayContaining(['local', SSH_HOST_ID]))
    expect(result.hostScope?.omittedHostIds).toEqual([])
  })

  it('names SSH in omittedHostIds when the cap fully excludes that host', async () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)
    mockListResolvedWorktrees(runtime, qaReproCatalog())

    const result = await runtime.listManagedWorktrees(undefined, LIMIT_EXCLUDING_SSH_HOST)

    expect(result.truncated).toBe(true)
    expect(result.totalCount).toBe(457)
    expect(result.worktrees.length).toBe(LIMIT_EXCLUDING_SSH_HOST)
    expect(result.worktrees.every((worktree) => worktree.hostId === 'local')).toBe(true)
    expect(result.hostScope?.hostIds).toEqual(['local'])
    expect(result.hostScope?.omittedHostIds).toEqual([SSH_HOST_ID])
  })
})

describe('getWorktreePs host scope', () => {
  it('includes SSH rows at the default limit when local worktrees dominate', async () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)
    mockListResolvedWorktreeSnapshot(runtime, qaReproCatalog())
    mockPtyControllerWithHostScope(runtime)

    const result = await runtime.getWorktreePs()

    expect(result.truncated).toBe(true)
    expect(result.totalCount).toBe(457)
    expect(result.worktrees.length).toBe(DEFAULT_WORKTREE_PS_LIMIT)
    expect(result.worktrees.some((worktree) => worktree.hostId === SSH_HOST_ID)).toBe(true)
    expect(result.worktrees.filter((worktree) => worktree.hostId === SSH_HOST_ID).length).toBe(23)
    expect(result.hostScope?.hostIds).toEqual(expect.arrayContaining(['local', SSH_HOST_ID]))
    expect(result.hostScope?.omittedHostIds).toEqual([])
  })

  it('names SSH in omittedHostIds when the cap fully excludes that host', async () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)
    mockListResolvedWorktreeSnapshot(runtime, qaReproCatalog())
    mockPtyControllerWithHostScope(runtime)

    const result = await runtime.getWorktreePs(LIMIT_EXCLUDING_SSH_HOST)

    expect(result.truncated).toBe(true)
    expect(result.totalCount).toBe(457)
    expect(result.worktrees.length).toBe(LIMIT_EXCLUDING_SSH_HOST)
    expect(result.worktrees.every((worktree) => worktree.hostId === 'local')).toBe(true)
    expect(result.hostScope?.hostIds).toEqual(['local'])
    expect(result.hostScope?.omittedHostIds).toEqual([SSH_HOST_ID])
  })
})
