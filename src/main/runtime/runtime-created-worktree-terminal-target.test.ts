import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { RuntimeStore } from './runtime-store-contract'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { mergeWorktree } from '../ipc/worktree-metadata-merge'
import { resolveCreatedWorktreeTerminalTarget } from './runtime-created-worktree-terminal-target'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

import { OrcaRuntimeService } from './orca-runtime'

class StartupRuntime extends OrcaRuntimeService {
  readonly lookup = vi.fn<(selector: string) => Promise<ResolvedWorktree>>()

  protected override resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree> {
    return this.lookup(selector)
  }
}

function owner(hostId: ExecutionHostId = 'local'): Repo {
  return {
    id: 'repo-1',
    path: '/repos/app',
    displayName: 'app',
    badgeColor: 'blue',
    addedAt: 1,
    executionHostId: hostId
  }
}

function makeFixture(repos: Repo[] = [owner()], hostId: ExecutionHostId = 'local') {
  const meta: WorktreeMeta = {
    instanceId: 'new-instance',
    hostId,
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
  const worktree = mergeWorktree(
    'repo-1',
    {
      path: '/workspaces/new',
      head: 'abc123',
      branch: 'refs/heads/new',
      isBare: false,
      isMainWorktree: false
    },
    meta
  )
  const metadata: Record<string, WorktreeMeta> = { [worktree.id]: meta }
  const lineageById: Record<string, WorktreeLineage> = {}
  const store: RuntimeStore = {
    getRepos: () => repos,
    getRepo: (id) => repos.find((repo) => repo.id === id),
    addRepo: vi.fn<RuntimeStore['addRepo']>(),
    updateRepo: vi.fn<RuntimeStore['updateRepo']>(),
    getAllWorktreeMeta: () => metadata,
    getWorktreeMeta: (id) => metadata[id],
    getAllWorktreeLineage: () => lineageById,
    setWorktreeMeta: (id, patch) => (metadata[id] = { ...meta, ...metadata[id], ...patch }),
    removeWorktreeMeta: (id) => {
      delete metadata[id]
    },
    getGitHubCache: vi.fn<RuntimeStore['getGitHubCache']>(),
    getSettings: () => ({
      workspaceDir: '/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    })
  }
  const runtime = new StartupRuntime(store)
  const fallback: ResolvedWorktree = {
    ...worktree,
    git: worktree,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null
  }
  runtime.lookup.mockResolvedValue(fallback)
  let ptySequence = 0
  const spawn = vi.fn(async () => ({ id: `new-pty-${++ptySequence}` }))
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, store, worktree, meta, metadata, lineageById, spawn }
}

describe('created worktree terminal evidence', () => {
  it('starts a terminal in the new checkout without querying the worktree inventory', async () => {
    const { runtime, worktree, spawn } = makeFixture()
    await runtime.createTerminal(`id:${worktree.id}`, { presentation: 'background' }, worktree)
    expect(runtime.lookup).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: worktree.path,
        worktreeId: worktree.id,
        connectionId: null,
        initiallyHidden: true
      })
    )
  })

  it('still resolves normally without internal creation evidence', async () => {
    const { runtime, worktree } = makeFixture()
    await runtime.createTerminal(`id:${worktree.id}`, { presentation: 'background' })
    expect(runtime.lookup).toHaveBeenCalledOnce()
  })

  it('starts a setup split without another worktree inventory query', async () => {
    const { runtime, worktree, spawn } = makeFixture()
    const terminal = await runtime.createTerminal(
      `id:${worktree.id}`,
      { presentation: 'background' },
      worktree
    )
    await runtime.splitTerminal(terminal.handle, { surfaceOwner: false }, worktree)
    expect(runtime.lookup).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: worktree.path, worktreeId: worktree.id, connectionId: null })
    )
  })

  it('uses ordinary resolution when the created instance has been replaced', async () => {
    const { runtime, worktree, metadata } = makeFixture()
    metadata[worktree.id] = { ...metadata[worktree.id]!, instanceId: 'replacement' }
    await runtime.createTerminal(`id:${worktree.id}`, { presentation: 'background' }, worktree)
    expect(runtime.lookup).toHaveBeenCalledOnce()
  })

  it('does not reuse creation evidence for a different selector or a replaced instance', async () => {
    const { store, worktree, metadata } = makeFixture()
    expect(resolveCreatedWorktreeTerminalTarget(store, 'branch:new', worktree)).toBeNull()
    expect(
      resolveCreatedWorktreeTerminalTarget(store, 'id:repo-1::/elsewhere', worktree)
    ).toBeNull()
    metadata[worktree.id] = { ...metadata[worktree.id]!, instanceId: 'replacement' }
    expect(resolveCreatedWorktreeTerminalTarget(store, `id:${worktree.id}`, worktree)).toBeNull()
  })

  it('routes an SSH-owned created checkout through its host when repo ids collide', async () => {
    const { runtime, worktree, spawn } = makeFixture([owner(), owner('ssh:builder')], 'ssh:builder')
    await runtime.createTerminal(`id:${worktree.id}`, { presentation: 'background' }, worktree)
    expect(runtime.lookup).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'builder' }))
  })

  it('checks the owner host metadata when a rival host shares the same locator', async () => {
    const { runtime, store, worktree, meta, metadata, spawn } = makeFixture(
      [owner(), owner('ssh:builder')],
      'ssh:builder'
    )
    Object.assign(store, {
      getWorktreeMetaForHost: (id: string, hostId: ExecutionHostId) =>
        id === worktree.id && hostId === 'ssh:builder' ? meta : undefined
    })
    metadata[worktree.id] = { ...meta, hostId: 'local', instanceId: 'rival-instance' }
    await runtime.createTerminal(`id:${worktree.id}`, { presentation: 'background' }, worktree)
    expect(runtime.lookup).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'builder' }))
  })

  it('rejects another host metadata and ambiguous legacy ownership', async () => {
    const { store, worktree, metadata } = makeFixture([owner(), owner('ssh:builder')])
    metadata[worktree.id] = { ...metadata[worktree.id]!, hostId: 'ssh:builder' }
    expect(resolveCreatedWorktreeTerminalTarget(store, `id:${worktree.id}`, worktree)).toBeNull()
    metadata[worktree.id] = { ...metadata[worktree.id]!, hostId: undefined }
    const unstamped: Worktree = { ...worktree, hostId: undefined }
    expect(resolveCreatedWorktreeTerminalTarget(store, `id:${worktree.id}`, unstamped)).toBeNull()
    expect(resolveCreatedWorktreeTerminalTarget(store, `id:${worktree.id}`, worktree)).toBeNull()
  })

  it('keeps folder workspaces on their existing launch lookup', () => {
    const { store, worktree } = makeFixture([{ ...owner(), kind: 'folder' }])
    expect(resolveCreatedWorktreeTerminalTarget(store, `id:${worktree.id}`, worktree)).toBeNull()
  })

  it('preserves stored lineage while rejecting stale parents and cycles', () => {
    const { store, worktree, meta, metadata, lineageById } = makeFixture()
    const parentId = 'repo-1::/workspaces/parent'
    const childId = 'repo-1::/workspaces/child'
    metadata[parentId] = { ...meta, instanceId: 'parent-instance' }
    metadata[childId] = { ...meta, instanceId: 'child-instance' }
    const lineage: WorktreeLineage = {
      worktreeId: worktree.id,
      worktreeInstanceId: 'new-instance',
      parentWorktreeId: parentId,
      parentWorktreeInstanceId: 'parent-instance',
      origin: 'cli',
      capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
      createdAt: 1
    }
    lineageById[worktree.id] = lineage
    lineageById[childId] = {
      ...lineage,
      worktreeId: childId,
      worktreeInstanceId: 'child-instance',
      parentWorktreeId: worktree.id,
      parentWorktreeInstanceId: 'new-instance'
    }
    const resolve = () => resolveCreatedWorktreeTerminalTarget(store, `id:${worktree.id}`, worktree)
    expect(resolve()).toEqual(
      expect.objectContaining({ parentWorktreeId: parentId, childWorktreeIds: [childId], lineage })
    )
    metadata[parentId] = { ...meta, instanceId: 'replacement' }
    expect(resolve()).toEqual(expect.objectContaining({ parentWorktreeId: null, lineage: null }))
    metadata[parentId] = { ...meta, instanceId: 'parent-instance' }
    lineageById[parentId] = {
      ...lineage,
      worktreeId: parentId,
      worktreeInstanceId: 'parent-instance',
      parentWorktreeId: worktree.id,
      parentWorktreeInstanceId: 'new-instance'
    }
    expect(resolve()).toEqual(expect.objectContaining({ parentWorktreeId: null, lineage: null }))
  })
})
