import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { store, TEST_WORKTREE_ID } from '../orca-runtime-test-fixtures.spec'
import type { Repo } from '../../../shared/repo-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import type { ResolvedWorktreeSnapshot } from '../runtime-resolved-worktree-cache'
import type { DetectedWorktreeListResult } from '../../../shared/worktree/types'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FLOATING_TERMINAL_WORKTREE_ID,
  getDefaultWorkspaceSession
} from '../../../shared/constants'
import type { BrowserTabInfo } from '../../../shared/runtime-browser-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { firstWorkRenameDeps } from '../../agent-hooks/first-work-rename-runtime'

const repo: Repo = {
  id: 'workspace-query',
  path: '/tmp/workspace-query',
  displayName: 'Workspace query',
  addedAt: 1,
  badgeColor: 'blue'
}
const resolved: ResolvedWorktree = {
  ...store.getWorktreeMeta(TEST_WORKTREE_ID),
  id: TEST_WORKTREE_ID,
  repoId: 'repo-1',
  path: '/tmp/worktree-a',
  branch: 'main',
  displayName: 'Workspace',
  linkedIssue: null,
  comment: '',
  parentWorktreeId: null,
  childWorktreeIds: [],
  lineage: null,
  git: {
    path: '/tmp/worktree-a',
    head: '',
    branch: 'main',
    isBare: false,
    isMainWorktree: false
  }
}
const snapshot: ResolvedWorktreeSnapshot = {
  worktrees: [resolved],
  platformByRepoId: new Map()
}

describe('workspace query prototype dispatch', () => {
  it('re-enters the runtime repo selector', async () => {
    const seen: unknown[][] = []
    class Probe extends OrcaRuntimeService {
      protected override selectReposBySelector(selector: string): Repo[] {
        seen.push([this, selector])
        return [repo]
      }
      run() {
        return this.resolveRepoSelector('id:workspace-query')
      }
    }
    const runtime = new Probe(store)
    await expect(runtime.run()).resolves.toBe(repo)
    expect(seen).toEqual([[runtime, 'id:workspace-query']])
  })

  it('re-enters the runtime snapshot from async listing', async () => {
    const seen: OrcaRuntimeService[] = []
    class Probe extends OrcaRuntimeService {
      protected override async listResolvedWorktreeSnapshot(): Promise<ResolvedWorktreeSnapshot> {
        seen.push(this)
        return snapshot
      }
      run() {
        return this.listResolvedWorktrees()
      }
    }
    const runtime = new Probe(store)
    await expect(runtime.run()).resolves.toEqual([resolved])
    expect(seen).toEqual([runtime])
  })

  it('calls the runtime scoped resolver with the original single argument', async () => {
    const seen: { receiver: OrcaRuntimeService; args: unknown[] }[] = []
    class Probe extends OrcaRuntimeService {
      protected override hasFreshResolvedWorktreeCache(): boolean {
        return false
      }
      protected override async resolveExplicitWorktreeIdScoped(
        _worktreeId: string,
        _hostId?: ExecutionHostId
      ): Promise<ResolvedWorktree> {
        seen.push({ receiver: this, args: Array.from(arguments) })
        return resolved
      }
      run() {
        return this.resolveGitWorktreeSelector(`id:${TEST_WORKTREE_ID}`)
      }
    }
    const runtime = new Probe(store)
    await expect(runtime.run()).resolves.toBe(resolved)
    expect(seen).toEqual([{ receiver: runtime, args: [TEST_WORKTREE_ID] }])
  })

  it('keeps disconnected SSH stored rows with a failed scan verdict', async () => {
    class Probe extends OrcaRuntimeService {
      run(remote: Repo) {
        return this.listRepoWorktreesForResolutionUncached(remote, undefined)
      }
    }
    const remote: Repo = { ...repo, executionHostId: 'ssh:workspace-query' }
    const id = `${repo.id}::/remote/stored-worktree`
    const meta = {
      ...store.getWorktreeMeta(TEST_WORKTREE_ID),
      hostId: remote.executionHostId,
      customName: 'Stored',
      comment: '',
      issueNumber: null,
      issueUrl: null,
      issueTitle: null,
      mergeStatus: null
    }
    const runtime = new Probe({
      ...store,
      getRepos: () => [remote],
      getAllWorktreeMeta: () => ({ [id]: meta }),
      getWorktreeMeta: () => meta
    })
    const result = await runtime.run(remote)
    expect(result.ok).toBe(false)
    expect(result.worktrees.map((row) => row.path)).toEqual(['/remote/stored-worktree'])
  })
})

describe('workspace-detected-listing-capture characterization', () => {
  describe('detected workspace listing during repo resolution', () => {
    it('captures the listing method before awaiting resolution and keeps its runtime receiver', async () => {
      const pending = Promise.withResolvers<Repo>()
      const events: string[] = []
      const repo: Repo = {
        id: 'repo',
        path: '/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 0
      }
      const result: DetectedWorktreeListResult = {
        repoId: repo.id,
        authoritative: true,
        source: 'git',
        worktrees: []
      }
      const runtime = new (class extends OrcaRuntimeService {
        override resolveRepoSelectorForConnection(selector: string, connectionId?: string | null) {
          events.push('resolve')
          expect([selector, connectionId]).toEqual(['repo', 'ssh:box'])
          return pending.promise
        }
      })()
      const original = vi.fn(function (
        this: OrcaRuntimeService,
        resolved: Repo,
        sourceDefaultsSupported?: boolean
      ) {
        events.push('invoke original')
        expect(this).toBe(runtime)
        expect([resolved, sourceDefaultsSupported]).toEqual([repo, false])
        return Promise.resolve(result)
      })
      const replacement = vi.fn(() => Promise.resolve({ ...result, repoId: 'replacement' }))
      let listing: (
        repo: Repo,
        sourceDefaultsSupported?: boolean
      ) => Promise<DetectedWorktreeListResult> = original
      Object.defineProperty(runtime, 'listDetectedWorktreesForResolvedRepo', {
        get: () => {
          events.push('capture listing')
          return listing
        }
      })

      const listingPromise = runtime.listDetectedManagedWorktrees('repo', 'ssh:box', false)
      listing = replacement
      pending.resolve(repo)

      await expect(listingPromise).resolves.toBe(result)
      expect(events).toEqual(['capture listing', 'resolve', 'invoke original'])
      expect(original).toHaveBeenCalledOnce()
      expect(replacement).not.toHaveBeenCalled()
    })
  })

  describe('workspace methods captured before request property reads', () => {
    it('captures port probes before reading repoId', async () => {
      const runtime = new OrcaRuntimeService()
      const events: string[] = []
      const original = vi.fn(async () => [])
      const replacement = vi.fn(async () => [])
      let probes = original
      Object.defineProperty(runtime, 'getWorkspacePortProbes', {
        get: () => {
          events.push('capture probes')
          return probes
        }
      })
      await runtime.killWorkspacePort({
        pid: 4242,
        port: 3020,
        get repoId() {
          events.push('read repoId')
          probes = replacement
          return 'repo'
        }
      })
      expect(events).toEqual(['capture probes', 'read repoId'])
      expect(original).toHaveBeenCalledWith('repo')
      expect(original.mock.contexts[0]).toBe(runtime)
      expect(replacement).not.toHaveBeenCalled()
    })

    it('captures file routing before reading the requested workspace', async () => {
      const runtime = new OrcaRuntimeService()
      const events: string[] = []
      const original = vi.fn(async () => ({ executionHostId: 'ssh:box' }))
      const replacement = vi.fn(async () => ({ executionHostId: 'ssh:box' }))
      let routing = original
      Object.defineProperty(runtime, 'resolveRuntimeFileTarget', {
        get: () => {
          events.push('capture routing')
          return routing
        }
      })
      await runtime.killWorkspacePortOnHost({
        executionHostId: 'ssh:box',
        pid: 4242,
        port: 3020,
        get worktree() {
          events.push('read worktree')
          routing = replacement
          return 'folder:remote'
        }
      })
      expect(events).toEqual(['capture routing', 'read worktree'])
      expect(original).toHaveBeenCalledWith('folder:remote')
      expect(original.mock.contexts[0]).toBe(runtime)
      expect(replacement).not.toHaveBeenCalled()
    })

    it('captures scan invalidation before reading the resolved repo id', async () => {
      const runtime = new OrcaRuntimeService()
      const events: string[] = []
      const original = vi.fn()
      const replacement = vi.fn()
      let invalidate = original
      const repo: Repo = {
        get id() {
          events.push('read repo id')
          invalidate = replacement
          return 'repo'
        },
        path: '/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 0
      }
      Object.defineProperty(runtime, 'invalidateWorktreeScanCacheForRepo', {
        get: () => {
          events.push('capture invalidation')
          return invalidate
        }
      })
      Object.defineProperty(runtime, 'resolveRepoSelectorForConnection', {
        value: async () => repo
      })
      const detected: DetectedWorktreeListResult = {
        repoId: 'repo',
        authoritative: false,
        source: 'metadata-fallback',
        worktrees: []
      }
      Object.defineProperty(runtime, 'listDetectedWorktreesForResolvedRepo', {
        value: async () => detected
      })

      await expect(runtime.teardownMissingManagedWorktreeTerminals('repo', [])).resolves.toEqual({
        stoppedWorktreeIds: []
      })
      expect(events).toEqual(['capture invalidation', 'read repo id'])
      expect(original).toHaveBeenCalledWith('repo')
      expect(original.mock.contexts[0]).toBe(runtime)
      expect(replacement).not.toHaveBeenCalled()
    })
  })
})

describe('workspace-file-target-capture characterization', () => {
  describe('floating workspace file target resolution', () => {
    it('captures the converter before awaiting the path and keeps its runtime receiver', async () => {
      const runtime = new OrcaRuntimeService()
      const pending = Promise.withResolvers<string>()
      const events: string[] = []
      const convert = runtime['floatingWorkspaceToResolvedWorktree']
      const original = vi.fn(function (this: OrcaRuntimeService, path: string) {
        events.push('invoke original')
        expect(this).toBe(runtime)
        return convert.call(this, path)
      })
      const replacement = vi.fn((path: string) => convert.call(runtime, path))
      let converter: typeof convert = original
      Object.defineProperty(runtime, 'floatingWorkspaceToResolvedWorktree', {
        get: () => {
          events.push('capture converter')
          return converter
        }
      })
      Object.defineProperty(runtime, 'resolveFloatingWorkspacePath', {
        value: () => {
          events.push('resolve path')
          return pending.promise
        }
      })
      const result = runtime['resolveRuntimeFileTarget'](FLOATING_TERMINAL_WORKTREE_ID)
      converter = replacement
      const path = join(tmpdir(), 'floating')
      pending.resolve(path)

      await expect(result).resolves.toMatchObject({
        worktree: { path },
        executionHostId: 'local'
      })
      expect(events).toEqual(['capture converter', 'resolve path', 'invoke original'])
      expect(original).toHaveBeenCalledWith(path)
      expect(replacement).not.toHaveBeenCalled()
    })
  })
})

describe('workspace-session-read-order characterization', () => {
  const WORKTREE_ID = 'repo::/workspace'

  describe('workspace session callable lookup order', () => {
    it('keeps the native refusal for a launcher without a workspace selector', async () => {
      const runtime = new OrcaRuntimeService(null)
      await expect(
        runtime.resolveOrchestrationAgentLauncherForTarget('missing-launcher', {})
      ).rejects.toBeInstanceOf(TypeError)
    })

    it('captures the browser reader before evaluating the snapshot workspace getter', () => {
      const runtime = new OrcaRuntimeService(null)
      const order: string[] = []
      const replacement = vi.fn(() => new Map<string, BrowserTabInfo>())
      const original = function (
        this: InstanceType<typeof OrcaRuntimeService>,
        worktreeId: string
      ) {
        expect(this).toBe(runtime)
        expect(worktreeId).toBe(WORKTREE_ID)
        order.push('original call')
        return new Map<string, BrowserTabInfo>()
      }
      Object.defineProperty(runtime, 'getListedBrowserTabsByPageId', {
        configurable: true,
        get: () => {
          order.push('reader lookup')
          return original
        }
      })
      const snapshot: RuntimeMobileSessionTabsSnapshot = {
        worktree: WORKTREE_ID,
        publicationEpoch: 'seed',
        snapshotVersion: 1,
        tabs: [],
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null
      }
      Object.defineProperty(snapshot, 'worktree', {
        get: () => {
          order.push('argument lookup')
          Object.defineProperty(runtime, 'getListedBrowserTabsByPageId', { value: replacement })
          return WORKTREE_ID
        }
      })
      expect(runtime['collectPublicMobileSessionTabIds'](snapshot)).toEqual(new Set())
      expect(order).toEqual(['reader lookup', 'argument lookup', 'original call'])
      expect(replacement).not.toHaveBeenCalled()
    })

    it('captures the title writer before constructing a session with getter-backed fields', () => {
      const runtime = new OrcaRuntimeService(null)
      const order: string[] = []
      const replacement = vi.fn()
      const original = function (
        this: InstanceType<typeof OrcaRuntimeService>,
        worktreeId: string,
        session: WorkspaceSessionState
      ) {
        expect(this).toBe(runtime)
        expect(worktreeId).toBe(WORKTREE_ID)
        expect(session.tabsByWorktree[WORKTREE_ID]?.[0]?.customTitle).toBe('renamed')
        order.push('original write')
      }
      const session = getDefaultWorkspaceSession()
      const tabs: WorkspaceSessionState['tabsByWorktree'] = {
        [WORKTREE_ID]: [
          {
            id: 'tab',
            ptyId: null,
            worktreeId: WORKTREE_ID,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
      let tabReads = 0
      Object.defineProperty(session, 'tabsByWorktree', {
        enumerable: true,
        get: () => {
          tabReads += 1
          if (tabReads === 2) {
            order.push('session spread')
            Object.defineProperty(runtime, 'setWorkspaceSessionForWorktree', { value: replacement })
          }
          return tabs
        }
      })
      Object.defineProperty(runtime, 'store', { value: { setWorkspaceSession: () => {} } })
      Object.defineProperty(runtime, 'getWorkspaceSessionForWorktree', { value: () => session })
      Object.defineProperty(runtime, 'setWorkspaceSessionForWorktree', {
        configurable: true,
        get: () => {
          order.push('writer lookup')
          return original
        }
      })
      runtime['persistHeadlessTerminalTitle'](WORKTREE_ID, 'tab', 'renamed')
      expect(order).toEqual(['writer lookup', 'session spread', 'original write'])
      expect(replacement).not.toHaveBeenCalled()
    })
  })
})

describe('first-work rename lazy Store capabilities', () => {
  type RenameStore = Parameters<typeof firstWorkRenameDeps>[0]
  type RenameDeps = ReturnType<typeof firstWorkRenameDeps>

  function renameStore(): RenameStore {
    return {
      getSettings: () => ({
        workspaceDir: '/workspace',
        nestWorkspaces: false,
        refreshLocalBaseRefOnWorktreeCreate: false,
        branchPrefix: 'none',
        branchPrefixCustom: ''
      }),
      getRepo: () => undefined,
      getRepos: () => [],
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn()
    }
  }

  const missingCalls: {
    name: string
    invoke: (deps: RenameDeps) => unknown
    provideFolder?: true
  }[] = [
    { name: 'display name', invoke: (deps) => deps.getCurrentDisplayName('folder:sample') },
    { name: 'folder path', invoke: (deps) => deps.getFolderWorkspacePath?.('folder:sample') },
    {
      name: 'pending rename',
      invoke: (deps) => deps.isPendingFirstAgentMessageRename?.('folder:sample')
    },
    { name: 'display write', invoke: (deps) => deps.setDisplayName('folder:sample', 'New') },
    { name: 'error read', invoke: (deps) => deps.setRenameError('folder:sample', 'Failure') },
    {
      name: 'error write',
      provideFolder: true,
      invoke: (deps) => deps.setRenameError('folder:sample', 'Failure')
    },
    { name: 'tab owner', invoke: (deps) => deps.resolveWorktreeIdForTab('tab') }
  ]

  it.each(missingCalls)(
    'preserves the direct missing $name capability failure',
    ({ invoke, provideFolder }) => {
      const store = renameStore()
      if (provideFolder) {
        store.getFolderWorkspace = () => undefined
      }
      const runtime = new OrcaRuntimeService(null)
      let notified = false
      runtime.notifyFolderWorkspaceChanged = () => {
        notified = true
      }
      const deps = firstWorkRenameDeps(store, runtime)
      expect(() => invoke(deps)).toThrow(TypeError)
      expect(notified).toBe(false)
      expect(deps.renameWorktreeFolder).toBeUndefined()
    }
  )

  it('looks up the current writer on each call and retains Store and Root receivers', () => {
    const store = renameStore()
    const runtime = new OrcaRuntimeService(null)
    const order: string[] = []
    runtime.notifyFolderWorkspaceChanged = function () {
      expect(this).toBe(runtime)
      order.push('notify')
    }
    const deps = firstWorkRenameDeps(store, runtime)
    const write: NonNullable<RenameStore['updateFolderWorkspace']> = function (
      this: RenameStore,
      id,
      updates
    ) {
      expect(this).toBe(store)
      expect(arguments).toHaveLength(2)
      expect(id).toBe('sample')
      expect(updates).toEqual({
        name: 'New',
        pendingFirstAgentMessageRename: false,
        firstAgentMessageRenameError: null
      })
      order.push('write')
      return null
    }
    Object.defineProperty(store, 'updateFolderWorkspace', {
      configurable: true,
      get() {
        order.push('lookup')
        return write
      }
    })
    deps.setDisplayName('folder:sample', 'New')
    expect(order).toEqual(['lookup', 'write', 'notify'])
    delete store.updateFolderWorkspace
    expect(() => deps.setDisplayName('folder:sample', 'Again')).toThrow(TypeError)
    expect(order).toEqual(['lookup', 'write', 'notify'])
  })
})
