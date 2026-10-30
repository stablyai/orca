import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../persistence/loading-store/store'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import { RuntimeRemoteFetchController } from './runtime-remote-fetch-controller'
import type { RemoteTrackingBase } from './runtime-remote-fetch-controller'
import type { OrcaRuntimeWithNotifySshStateChanged } from './workspaces/workspace-host-notifications'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { PreparationRearmHolder } from '../worktree-create-preparation'
import type { RuntimeWorkspaceCreateEvents } from '../workspace-create-telemetry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { RuntimeStore } from './runtime-store-contract'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { mergeWorktree } from '../ipc/worktree-metadata-merge'
import { resolveCreatedWorktreeTerminalTarget } from './runtime-created-worktree-terminal-target'
import { committingSpawn } from './bind-first-pane.test-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

import { OrcaRuntimeService } from './orca-runtime'

class StartupRuntime extends OrcaRuntimeService {
  readonly lookup = vi.fn<(selector: string) => Promise<ResolvedWorktree>>()
  readonly repoLookup = vi.fn<(selector: string) => Promise<Repo>>()

  protected override resolveRepoSelector(selector: string): Promise<Repo> {
    return this.repoLookup(selector)
  }

  protected override resolveGitWorktreeSelector(selector: string): Promise<ResolvedWorktree> {
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
    setWorktreeMeta: (target, patch) =>
      (metadata[target.id] = { ...meta, ...metadata[target.id], ...patch }),
    removeWorktreeMeta: (target) => {
      delete metadata[target.id]
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
  const spawn = vi.fn(async (_args: { worktreeId?: string; tabId?: string; leafId?: string }) => ({
    id: `new-pty-${++ptySequence}`
  }))
  runtime.setPtyController({
    spawn: committingSpawn(runtime, spawn),
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

describe('workspace activation and metadata reentry', () => {
  const trackingBase: RemoteTrackingBase = {
    remote: 'origin',
    branch: 'main',
    ref: 'origin/main',
    base: 'main'
  }
  const ownerFailure = new Error('owner callback bypassed runtime')

  class ControlledRemoteFetches extends RuntimeRemoteFetchController {
    override async resolveRemoteTrackingBase(): Promise<RemoteTrackingBase> {
      return trackingBase
    }
    override async fetchRemoteWithCache(): Promise<void> {
      throw ownerFailure
    }
  }

  class MetadataRuntime extends OrcaRuntimeService {
    protected override readonly remoteFetches = new ControlledRemoteFetches()
    constructor(
      store: Store,
      readonly selectedWorktree: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
    ) {
      super(store)
    }

    override async resolveGitWorktreeSelector(): Promise<ResolvedWorktree> {
      return this.selectedWorktree
    }

    override async showManagedWorktree() {
      return this.selectedWorktree
    }

    override notifyWorktreesChanged(
      ...args: Parameters<OrcaRuntimeWithNotifySshStateChanged['notifyWorktreesChanged']>
    ) {
      super.notifyWorktreesChanged(...args)
    }
  }

  let directory: string
  let store: Store
  let runtime: MetadataRuntime

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-metadata-reentry-'))
    store = new Store({
      dataFile: join(directory, 'state.json'),
      profileStateAuthority: new ProfileStateSqliteAuthority(
        join(directory, 'profile.db'),
        'reentry'
      )
    })
    store.addRepo({
      id: 'repo',
      path: directory,
      displayName: 'Repo',
      badgeColor: 'blue',
      addedAt: 0,
      worktreeBaseRef: 'main'
    })
    const path = join(directory, 'checkout')
    const worktree: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>> = {
      id: `repo::${path}`,
      repoId: 'repo',
      path,
      branch: 'feature',
      head: '',
      isBare: false,
      isMainWorktree: false,
      displayName: 'Feature',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedItems: [],
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: { path, head: '', branch: 'feature', isBare: false, isMainWorktree: false }
    }
    runtime = new MetadataRuntime(store, worktree)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    store.freezeWrites()
    rmSync(directory, { recursive: true, force: true })
  })

  it('uses a runtime tracking-base replacement installed after construction', async () => {
    const calls: { receiver: unknown; args: unknown[] }[] = []
    vi.spyOn(runtime, 'resolveRemoteTrackingBase').mockImplementation(async function (
      this: unknown,
      ...args
    ) {
      calls.push({ receiver: this, args })
      return null
    })
    await expect(runtime.probeWorktreeDrift('selected')).resolves.toBeNull()
    expect(calls).toEqual([{ receiver: runtime, args: [directory, 'main', {}] }])
  })

  it('uses the runtime fetch replacement with its original receiver and arguments', async () => {
    const failure = new Error('runtime fetch override')
    const resolve = vi.spyOn(runtime, 'resolveRemoteTrackingBase').mockResolvedValue(trackingBase)
    const calls: { receiver: unknown; args: unknown[] }[] = []
    vi.spyOn(runtime, 'fetchRemoteWithCache').mockImplementation(async function (
      this: unknown,
      ...args
    ) {
      calls.push({ receiver: this, args })
      throw failure
    })
    await expect(runtime.probeWorktreeDrift('selected')).rejects.toBe(failure)
    expect(resolve).toHaveBeenCalledExactlyOnceWith(directory, 'main', {})
    expect(calls).toEqual([{ receiver: runtime, args: [directory, 'origin', {}] }])
  })

  it('retains omitted notification options and explicit sort-order options', async () => {
    const notify = vi.spyOn(runtime, 'notifyWorktreesChanged').mockImplementation(() => {})
    await runtime.updateManagedWorktreeMeta('selected', { comment: 'updated' })
    expect(store.getWorktreeMeta(runtime.selectedWorktree.id)?.comment).toBe('updated')
    expect(notify.mock.calls).toEqual([['repo']])
    const otherId = `repo::${join(directory, 'other')}`
    store.setWorktreeMeta(
      hostWorktreeTarget({ id: runtime.selectedWorktree.id, hostId: 'local' }),
      { sortOrder: 0 }
    )
    store.setWorktreeMeta(hostWorktreeTarget({ id: otherId, hostId: 'local' }), { sortOrder: 0 })
    expect(runtime.persistManagedWorktreeSortOrder([runtime.selectedWorktree.id, otherId])).toEqual(
      {
        updated: 2
      }
    )
    expect(notify.mock.calls).toEqual([
      ['repo'],
      [
        'repo',
        {
          invalidateGitScans: false,
          sortOrderOnly: true,
          sortOrders: [
            { worktreeId: runtime.selectedWorktree.id, sortOrder: expect.any(Number) },
            { worktreeId: otherId, sortOrder: expect.any(Number) }
          ]
        }
      ]
    ])
  })

  function configureMobileActivation(): () => number {
    let reads = 0
    const worktreeId = runtime.selectedWorktree.id
    Object.defineProperty(runtime.selectedWorktree, 'id', {
      get: () => {
        reads += 1
        return worktreeId
      }
    })
    // Only availability is consumed here; the fixture creates no desktop window.
    Object.defineProperties(runtime, {
      getAvailableAuthoritativeWindow: { configurable: true, value: () => ({}) },
      assertGraphReady: { value: () => {} },
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession: { value: () => {} },
      refreshMobileSessionPtyRecords: { value: async () => null },
      notifyMobileSessionTabsChanged: { value: () => {} }
    })
    return () => reads
  }

  it.each([
    { label: 'absent notifier', notifier: null },
    { label: 'missing optional notifier method', notifier: {} }
  ])("still queues main's wake with $label", async ({ notifier }) => {
    const reads = configureMobileActivation()
    Object.defineProperty(runtime, 'notifier', { value: notifier })
    await expect(
      runtime.activateManagedWorktree('selected', { clientKind: 'mobile' })
    ).resolves.toMatchObject({ sleepingAgentWake: 'requested' })
    expect(reads()).toBe(5)
  })

  it('looks up the sleeping callback late and keeps its notifier receiver', async () => {
    const reads = configureMobileActivation()
    const calls: { receiver: unknown; args: string[] }[] = []
    const notifier = {
      resumeSleepingAgents(this: unknown, ...args: string[]) {
        calls.push({ receiver: this, args })
      }
    }
    let currentNotifier: object = {}
    Object.defineProperty(runtime, 'notifier', { get: () => currentNotifier })
    Object.defineProperty(runtime, 'getAvailableAuthoritativeWindow', {
      value: () => {
        currentNotifier = notifier
        return {}
      }
    })
    await runtime.activateManagedWorktree('selected', { clientKind: 'mobile' })
    expect(reads()).toBe(5)
    // The window's callback runs once main's queued resume has.
    await vi.waitFor(() =>
      expect(calls).toEqual([{ receiver: notifier, args: [runtime.selectedWorktree.id] }])
    )
  })
})

describe('managed creation runtime entry', () => {
  it.each(['local-repo', 'folder-repo', 'ssh-repo'])(
    'refuses %s before resolving or creating its workspace',
    async (repoSelector) => {
      const { runtime } = makeFixture()
      runtime.repoLookup.mockRejectedValue(new Error('repo_read_before_model_refusal'))
      await expect(
        runtime.createManagedWorktree({
          repoSelector,
          name: 'unverified-model',
          startupAgent: 'opencode',
          startupLaunchPreferences: { model: 'private-proof/model-b' }
        })
      ).rejects.toMatchObject({ code: 'capability_unsupported' })
      expect(runtime.repoLookup).not.toHaveBeenCalled()
    }
  )

  it('preserves worktree creation without a model preference', async () => {
    const { runtime } = makeFixture()
    runtime.repoLookup.mockRejectedValue(new Error('repo_read_before_model_refusal'))
    await expect(
      runtime.createManagedWorktree({
        repoSelector: 'local-repo',
        name: 'ordinary',
        startupAgent: 'opencode'
      })
    ).rejects.toThrow('repo_read_before_model_refusal')
    expect(runtime.repoLookup).toHaveBeenCalledOnce()
  })

  it('calls the private creation entry on the runtime and rearms after its rejection', async () => {
    const { runtime } = makeFixture()
    const failure = new Error('private runtime creation entry')
    const order: string[] = []
    const calls: { receiver: unknown; args: unknown[] }[] = []
    Object.defineProperty(runtime, 'performManagedWorktreeCreate', {
      value: async function (
        this: unknown,
        request: RuntimeManagedWorktreeCreateArgs,
        rearm: PreparationRearmHolder,
        events: RuntimeWorkspaceCreateEvents
      ) {
        calls.push({ receiver: this, args: [request, rearm, events] })
        order.push('private entry')
        rearm.fire = () => order.push('rearm')
        throw failure
      }
    })
    const request = { repoSelector: 'local-repo', name: 'ordinary' }
    await expect(runtime.createManagedWorktree(request)).rejects.toBe(failure)
    expect(calls).toEqual([
      {
        receiver: runtime,
        args: [request, { fire: expect.any(Function) }, { begin: expect.any(Function) }]
      }
    ])
    expect(order).toEqual(['private entry', 'rearm'])
  })
})
