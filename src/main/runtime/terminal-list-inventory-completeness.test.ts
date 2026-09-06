import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'

// An agent read `truncated: false` as a complete inventory while the same response was naming
// omitted remote hosts. Completeness must be its own verdict, not inferred from the page flag.

const LOCAL_WORKTREE_ID = 'repo-local::/tmp/local-worktree'
const LOCAL_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'

const REPOS = [
  {
    id: 'repo-local',
    path: '/tmp/local-worktree',
    displayName: 'local',
    badgeColor: '#000000',
    addedAt: 0
  }
]

function makeStore(hostIds: string[]) {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    getWorkspaceSessionHostIds: vi.fn(() => hostIds),
    getFolderWorkspaces: vi.fn((): FolderWorkspace[] => []),
    getProjectGroups: vi.fn(() => []),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => REPOS),
    getRepo: vi.fn((id: string) => REPOS.find((repo) => repo.id === id)),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

function makeRuntime(hostIds: string[], leafCount = 1): OrcaRuntimeService {
  const leafIds = [LOCAL_LEAF_ID, SECOND_LEAF_ID].slice(0, leafCount)
  const runtime = new OrcaRuntimeService(makeStore(hostIds) as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses: vi.fn(async () =>
      leafIds.map((_leafId, index) => ({ id: `pty-local-${index + 1}`, cwd: '/tmp' }))
    )
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: leafIds.map((leafId, index) => ({
      tabId: `tab-${index + 1}`,
      worktreeId: LOCAL_WORKTREE_ID,
      title: '',
      activeLeafId: leafId,
      layout: null
    })),
    leaves: leafIds.map((leafId, index) => ({
      tabId: `tab-${index + 1}`,
      worktreeId: LOCAL_WORKTREE_ID,
      leafId,
      paneRuntimeId: index + 1,
      ptyId: `pty-local-${index + 1}`,
      paneTitle: null,
      title: ''
    }))
  })
  return runtime
}

describe('listTerminals inventory completeness', () => {
  it('declares the inventory incomplete when a host is omitted, even untruncated', async () => {
    const result = await makeRuntime(['local', 'ssh:box-1']).listTerminals()

    expect(result.truncated).toBe(false)
    expect(result.hostScope?.omittedHostIds).toEqual(['ssh:box-1'])
    expect(result.hostScope?.complete).toBe(false)
  })

  it('declares the inventory complete only when every known host was covered', async () => {
    const result = await makeRuntime(['local']).listTerminals()

    expect(result.hostScope?.omittedHostIds).toEqual([])
    expect(result.hostScope?.complete).toBe(true)
  })

  it('bounds the verdict with the host clock it was observed at', async () => {
    const before = Date.now()

    const result = await makeRuntime(['local']).listTerminals()

    expect(result.hostScope?.observedAt).toBeGreaterThanOrEqual(before)
  })

  it('does not call a truncated page complete even when every host was covered', async () => {
    const result = await makeRuntime(['local'], 2).listTerminals(undefined, 1)

    expect(result.truncated).toBe(true)
    expect(result.hostScope?.omittedHostIds).toEqual([])
    expect(result.hostScope?.complete).toBe(false)
  })
})
