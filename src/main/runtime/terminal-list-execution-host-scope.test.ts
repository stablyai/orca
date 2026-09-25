import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'

// An agent once declared a task exited because `terminal list` came back without
// its worker: the worker was live on an SSH host, and nothing in the response
// said the listing was scoped or which host each row ran on.

const LOCAL_WORKTREE_ID = 'repo-local::/tmp/local-worktree'
const SSH_WORKTREE_ID = 'repo-ssh::/remote/ssh-worktree'
const LOCAL_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SSH_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const REMOTE_LEAF_ID = '33333333-3333-4333-8333-333333333333'

const REPOS = [
  {
    id: 'repo-local',
    path: '/tmp/local-worktree',
    displayName: 'local',
    badgeColor: '#000000',
    addedAt: 0
  },
  {
    id: 'repo-ssh',
    path: '/remote/ssh-worktree',
    displayName: 'ssh',
    badgeColor: '#000000',
    addedAt: 0,
    connectionId: 'box-1'
  }
]

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    getWorkspaceSessionHostIds: vi.fn(() => ['local', 'ssh:box-1']),
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

function makeSshFolderWorkspace() {
  return {
    id: 'folder-ssh',
    projectGroupId: 'group-1',
    name: 'SSH folder',
    folderPath: '/remote/folder',
    connectionId: 'box-2',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

function makeRuntimeFolderWorkspace() {
  return {
    ...makeSshFolderWorkspace(),
    id: 'folder-runtime',
    name: 'Runtime folder',
    connectionId: 'stale-box',
    executionHostId: 'runtime:env-9' as const
  }
}

type GraphLeaf = { worktreeId: string; leafId: string; ptyId: string }

function makeRuntime(leaves: GraphLeaf[], store = makeStore()): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses: vi.fn(async () => leaves.map((leaf) => ({ id: leaf.ptyId, cwd: '/tmp' })))
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: leaves.map((leaf, index) => ({
      tabId: `tab-${index + 1}`,
      worktreeId: leaf.worktreeId,
      title: '',
      activeLeafId: leaf.leafId,
      layout: null
    })),
    leaves: leaves.map((leaf, index) => ({
      tabId: `tab-${index + 1}`,
      worktreeId: leaf.worktreeId,
      leafId: leaf.leafId,
      paneRuntimeId: index + 1,
      ptyId: leaf.ptyId,
      paneTitle: null,
      title: ''
    }))
  })
  return runtime
}

describe('listTerminals execution-host identity', () => {
  it('names the SSH connection a remote terminal runs on instead of local', async () => {
    const runtime = makeRuntime([
      { worktreeId: LOCAL_WORKTREE_ID, leafId: LOCAL_LEAF_ID, ptyId: 'pty-local-1' },
      { worktreeId: SSH_WORKTREE_ID, leafId: SSH_LEAF_ID, ptyId: 'ssh:box-1@@pty-7' }
    ])

    const { terminals } = await runtime.listTerminals()

    const sshRow = terminals.find((terminal) => terminal.ptyId === 'ssh:box-1@@pty-7')
    const localRow = terminals.find((terminal) => terminal.ptyId === 'pty-local-1')
    expect(sshRow?.executionHostId).toBe('ssh:box-1')
    expect(localRow?.executionHostId).toBe('local')
  })

  it('names the paired runtime environment a mirrored terminal belongs to', async () => {
    const runtime = makeRuntime([
      {
        worktreeId: LOCAL_WORKTREE_ID,
        leafId: REMOTE_LEAF_ID,
        ptyId: 'remote:env-7@@handle-1'
      }
    ])

    const { terminals } = await runtime.listTerminals()

    expect(terminals[0]?.executionHostId).toBe('runtime:env-7')
  })

  it('leaves the host unset — never local — for a paired PTY that names no environment', async () => {
    const runtime = makeRuntime([
      { worktreeId: LOCAL_WORKTREE_ID, leafId: REMOTE_LEAF_ID, ptyId: 'remote:handle-1' }
    ])

    const { hostScope, terminals } = await runtime.listTerminals()

    expect(terminals[0]?.executionHostId).toBeUndefined()
    expect(hostScope?.hostIds).toEqual(['local'])
  })

  it.each([
    'remote:env@@%E0%A4%A',
    'remote:%20@@terminal%3Aone',
    'ssh:%E0%A4%A@@pty-7',
    'ssh:%20@@pty-7'
  ])('leaves the host unset for a malformed foreign PTY id: %s', async (ptyId) => {
    const runtime = makeRuntime([{ worktreeId: LOCAL_WORKTREE_ID, leafId: REMOTE_LEAF_ID, ptyId }])

    const { hostScope, terminals } = await runtime.listTerminals()

    expect(terminals[0]?.executionHostId).toBeUndefined()
    expect(hostScope?.hostIds).toEqual(['local'])
  })
})

describe('listTerminals scope declaration', () => {
  it('declares every host an unscoped listing covers', async () => {
    const runtime = makeRuntime([
      { worktreeId: LOCAL_WORKTREE_ID, leafId: LOCAL_LEAF_ID, ptyId: 'pty-local-1' },
      { worktreeId: SSH_WORKTREE_ID, leafId: SSH_LEAF_ID, ptyId: 'ssh:box-1@@pty-7' }
    ])

    const result = await runtime.listTerminals()

    expect(result.hostScope?.hostIds).toEqual(['local', 'ssh:box-1'])
    expect(result.hostScope?.omittedHostIds).toEqual([])
  })

  it('does not claim a paired runtime was covered from a mirrored row', async () => {
    const runtime = makeRuntime([
      {
        worktreeId: LOCAL_WORKTREE_ID,
        leafId: REMOTE_LEAF_ID,
        ptyId: 'remote:env-7@@handle-1'
      }
    ])

    const result = await runtime.listTerminals()

    expect(result.hostScope?.hostIds).toEqual(['local'])
    expect(result.hostScope?.omittedHostIds).toEqual(['runtime:env-7', 'ssh:box-1'])
  })

  it('keeps a repo-known paired runtime omitted without a mirrored row', async () => {
    const baseStore = makeStore()
    const repos = [
      REPOS[0]!,
      {
        id: 'repo-runtime',
        path: '/remote/runtime-worktree',
        displayName: 'runtime',
        badgeColor: '#000000',
        addedAt: 0,
        executionHostId: 'runtime:env-9' as const
      }
    ]
    const runtime = makeRuntime([], {
      ...baseStore,
      getRepos: vi.fn(() => repos),
      getRepo: vi.fn((id: string) => repos.find((repo) => repo.id === id)),
      getWorkspaceSessionHostIds: vi.fn(() => ['local'])
    })

    const result = await runtime.listTerminals()

    expect(result.hostScope?.hostIds).toEqual(['local'])
    expect(result.hostScope?.omittedHostIds).toEqual(['runtime:env-9'])
  })

  it('keeps a repo-known paired runtime omitted in a worktree-scoped listing', async () => {
    const baseStore = makeStore()
    const repos = [
      REPOS[0]!,
      {
        id: 'repo-runtime',
        path: '/remote/runtime-worktree',
        displayName: 'runtime',
        badgeColor: '#000000',
        addedAt: 0,
        executionHostId: 'runtime:env-9' as const
      }
    ]
    const runtime = makeRuntime([], {
      ...baseStore,
      getRepos: vi.fn(() => repos),
      getRepo: vi.fn((id: string) => repos.find((repo) => repo.id === id)),
      getWorkspaceSessionHostIds: vi.fn(() => ['local'])
    })

    const result = await runtime.listTerminals(`id:${LOCAL_WORKTREE_ID}`)

    expect(result.hostScope?.hostIds).toEqual(['local'])
    expect(result.hostScope?.omittedHostIds).toEqual(['runtime:env-9'])
  })

  it('covers a queried SSH host used only by a folder workspace', async () => {
    const baseStore = makeStore()
    const folderWorkspace = makeSshFolderWorkspace()
    const runtime = makeRuntime([], {
      ...baseStore,
      getRepos: vi.fn(() => [REPOS[0]!]),
      getRepo: vi.fn((id: string) => (id === REPOS[0]!.id ? REPOS[0] : undefined)),
      getWorkspaceSessionHostIds: vi.fn(() => ['local']),
      getFolderWorkspaces: vi.fn(() => [folderWorkspace])
    })
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'never' })),
      write: () => true,
      kill: () => true,
      listProcesses: vi.fn(async () => []),
      listProcessesWithHostScope: vi.fn(async () => ({
        processes: [],
        hostIds: ['local', 'ssh:box-2']
      }))
    } as never)

    const result = await runtime.listTerminals(`id:${folderWorkspaceKey(folderWorkspace.id)}`)

    expect(result.hostScope?.hostIds).toEqual(['ssh:box-2'])
    expect(result.hostScope?.omittedHostIds).toEqual(['local'])
  })

  it('keeps a disconnected folder-workspace SSH host omitted', async () => {
    const baseStore = makeStore()
    const folderWorkspace = makeSshFolderWorkspace()
    const runtime = makeRuntime([], {
      ...baseStore,
      getRepos: vi.fn(() => [REPOS[0]!]),
      getRepo: vi.fn((id: string) => (id === REPOS[0]!.id ? REPOS[0] : undefined)),
      getWorkspaceSessionHostIds: vi.fn(() => ['local']),
      getFolderWorkspaces: vi.fn(() => [folderWorkspace])
    })
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'never' })),
      write: () => true,
      kill: () => true,
      listProcesses: vi.fn(async () => {
        throw new Error('relay unavailable')
      })
    } as never)

    const result = await runtime.listTerminals(`id:${folderWorkspaceKey(folderWorkspace.id)}`)

    expect(result.hostScope?.hostIds).toEqual([])
    expect(result.hostScope?.omittedHostIds).toEqual(['local', 'ssh:box-2'])
  })

  it('does not claim local coverage for a paired-runtime folder workspace', async () => {
    const baseStore = makeStore()
    const folderWorkspace = makeRuntimeFolderWorkspace()
    const runtime = makeRuntime([], {
      ...baseStore,
      getRepos: vi.fn(() => [REPOS[0]!]),
      getRepo: vi.fn((id: string) => (id === REPOS[0]!.id ? REPOS[0] : undefined)),
      getWorkspaceSessionHostIds: vi.fn(() => ['local']),
      getFolderWorkspaces: vi.fn(() => [folderWorkspace])
    })

    const result = await runtime.listTerminals(`id:${folderWorkspaceKey(folderWorkspace.id)}`)

    expect(result.hostScope?.hostIds).toEqual([])
    expect(result.hostScope?.omittedHostIds).toEqual(['local', 'runtime:env-9'])
  })

  it('keeps a paired-runtime folder owner omitted in an unscoped listing', async () => {
    const baseStore = makeStore()
    const folderWorkspace = makeRuntimeFolderWorkspace()
    const runtime = makeRuntime([], {
      ...baseStore,
      getRepos: vi.fn(() => [REPOS[0]!]),
      getRepo: vi.fn((id: string) => (id === REPOS[0]!.id ? REPOS[0] : undefined)),
      getWorkspaceSessionHostIds: vi.fn(() => ['local']),
      getFolderWorkspaces: vi.fn(() => [folderWorkspace])
    })

    const result = await runtime.listTerminals()

    expect(result.hostScope?.hostIds).toEqual(['local'])
    expect(result.hostScope?.omittedHostIds).toEqual(['runtime:env-9'])
  })

  it('keeps a disconnected SSH host omitted when only local inventory answered', async () => {
    const runtime = makeRuntime([])
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'never' })),
      write: () => true,
      kill: () => true,
      listProcesses: vi.fn(async () => [])
    } as never)

    const result = await runtime.listTerminals()

    expect(result.hostScope?.hostIds).toEqual(['local'])
    expect(result.hostScope?.omittedHostIds).toEqual(['ssh:box-1'])
  })

  it('marks every known host omitted when process inventory is unverifiable', async () => {
    const runtime = makeRuntime([])
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'never' })),
      write: () => true,
      kill: () => true,
      listProcesses: vi.fn(async () => {
        throw new Error('relay unavailable')
      })
    } as never)

    const result = await runtime.listTerminals()

    expect(result.hostScope?.hostIds).toEqual([])
    expect(result.hostScope?.omittedHostIds).toEqual(['local', 'ssh:box-1'])
  })

  // The renderer's surface census can read an empty scope on a plain local machine, not
  // only on a degraded host: a superseded inventory answers for no host at all.
  it('reports an empty scope when a concurrent inventory refresh supersedes this one', async () => {
    const runtime = makeRuntime([])
    const releases: (() => void)[] = []
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'never' })),
      write: () => true,
      kill: () => true,
      listProcesses: vi.fn(async () => []),
      listProcessesWithHostScope: vi.fn(
        () =>
          new Promise((resolve) => {
            releases.push(() => resolve({ processes: [], hostIds: ['local'] }))
          })
      )
    } as never)

    const superseded = runtime.listTerminals(`id:${LOCAL_WORKTREE_ID}`)
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    const current = runtime.listTerminals(`id:${LOCAL_WORKTREE_ID}`)
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases[1]!()
    releases[0]!()

    expect((await superseded).hostScope?.hostIds).toEqual([])
    expect((await current).hostScope?.hostIds).toEqual(['local'])
  })

  it('reports the hosts a worktree-scoped listing skipped, so an empty result is not absolute', async () => {
    const runtime = makeRuntime([
      { worktreeId: SSH_WORKTREE_ID, leafId: SSH_LEAF_ID, ptyId: 'ssh:box-1@@pty-7' }
    ])

    const result = await runtime.listTerminals(`id:${LOCAL_WORKTREE_ID}`)

    expect(result.terminals).toEqual([])
    expect(result.hostScope?.hostIds).toEqual(['local'])
    expect(result.hostScope?.omittedHostIds).toEqual(['ssh:box-1'])
  })
})
