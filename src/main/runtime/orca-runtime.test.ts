/* eslint-disable max-lines -- Why: runtime behavior is stateful and cross-cutting, so these tests stay in one file to preserve the end-to-end invariants around handles, waits, and graph sync. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeLineage, WorktreeMeta } from '../../shared/types'
import { addWorktree, listWorktrees, removeWorktree } from '../git/worktree'
import {
  createSetupRunnerScript,
  getEffectiveHooks,
  hasHooksFile,
  parseOrcaYaml,
  runHook,
  shouldRunSetupForCreate
} from '../hooks'
import { getDefaultBaseRef } from '../git/repo'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'

const {
  MOCK_GIT_WORKTREES,
  addWorktreeMock,
  removeWorktreeMock,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  sshGitProviders,
  getSshGitProviderMock,
  registerSshGitProviderMock,
  unregisterSshGitProviderMock,
  invalidateAuthorizedRootsCacheMock
} = vi.hoisted(() => {
  // Why: SSH runtime tests register providers through the public dispatcher API,
  // so the mock needs the same registry semantics as the real module.
  const sshGitProviders = new Map<string, unknown>()

  return {
    MOCK_GIT_WORKTREES: [
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/foo',
        isBare: false,
        isMainWorktree: false
      }
    ],
    addWorktreeMock: vi.fn(),
    removeWorktreeMock: vi.fn(),
    computeWorktreePathMock: vi.fn(),
    ensurePathWithinWorkspaceMock: vi.fn(),
    sshGitProviders,
    getSshGitProviderMock: vi.fn((connectionId: string) => sshGitProviders.get(connectionId)),
    registerSshGitProviderMock: vi.fn((connectionId: string, provider: unknown) => {
      sshGitProviders.set(connectionId, provider)
    }),
    unregisterSshGitProviderMock: vi.fn((connectionId: string) => {
      sshGitProviders.delete(connectionId)
    }),
    invalidateAuthorizedRootsCacheMock: vi.fn()
  }
})

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES),
  addWorktree: addWorktreeMock,
  removeWorktree: removeWorktreeMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  registerSshGitProvider: registerSshGitProviderMock,
  unregisterSshGitProvider: unregisterSshGitProviderMock
}))

vi.mock('../hooks', () => ({
  createSetupRunnerScript: vi.fn(),
  getEffectiveHooks: vi.fn().mockReturnValue(null),
  runHook: vi.fn().mockResolvedValue({ success: true, output: '' }),
  shouldRunSetupForCreate: vi
    .fn()
    .mockImplementation((_repo: never, decision: string) => decision === 'run'),
  getEffectiveSetupRunPolicy: vi.fn().mockReturnValue('auto'),
  hasHooksFile: vi.fn().mockReturnValue(false),
  parseOrcaYaml: vi.fn().mockReturnValue(null)
}))

vi.mock('../ipc/worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    computeWorktreePath: computeWorktreePathMock,
    ensurePathWithinWorkspace: ensurePathWithinWorkspaceMock
  }
})

vi.mock('../ipc/filesystem-auth', () => ({
  invalidateAuthorizedRootsCache: invalidateAuthorizedRootsCacheMock
}))

// Why: the CLI create-worktree path calls getDefaultBaseRef to resolve a
// fallback base branch. Real resolution shells out to `git` against the
// test's fabricated repo path, which has no refs, so we stub it to a
// predictable 'origin/main'. The runtime no longer silently fabricates this
// default, so tests that want the legacy behavior must express it via the mock.
vi.mock('../git/repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getDefaultBaseRef: vi.fn().mockReturnValue('origin/main'),
    getBranchConflictKind: vi.fn().mockResolvedValue(null),
    getGitUsername: vi.fn().mockReturnValue('')
  }
})

afterEach(() => {
  vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
  vi.mocked(addWorktree).mockReset()
  vi.mocked(removeWorktree).mockReset()
  sshGitProviders.clear()
  getSshGitProviderMock.mockReset()
  getSshGitProviderMock.mockImplementation((connectionId: string) =>
    sshGitProviders.get(connectionId)
  )
  registerSshGitProviderMock.mockReset()
  registerSshGitProviderMock.mockImplementation((connectionId: string, provider: unknown) => {
    sshGitProviders.set(connectionId, provider)
  })
  unregisterSshGitProviderMock.mockReset()
  unregisterSshGitProviderMock.mockImplementation((connectionId: string) => {
    sshGitProviders.delete(connectionId)
  })
  vi.mocked(createSetupRunnerScript).mockReset()
  vi.mocked(getEffectiveHooks).mockReset()
  vi.mocked(hasHooksFile).mockReset()
  vi.mocked(parseOrcaYaml).mockReset()
  vi.mocked(runHook).mockReset()
  vi.mocked(shouldRunSetupForCreate).mockReset()
  vi.mocked(shouldRunSetupForCreate).mockImplementation((_repo, decision) => decision === 'run')
  vi.mocked(getEffectiveHooks).mockReturnValue(null)
  vi.mocked(hasHooksFile).mockReturnValue(false)
  vi.mocked(parseOrcaYaml).mockReturnValue(null)
  computeWorktreePathMock.mockReset()
  ensurePathWithinWorkspaceMock.mockReset()
  invalidateAuthorizedRootsCacheMock.mockReset()
})

function syncSinglePty(runtime: OrcaRuntimeService, ptyId: string | null = 'pty-1'): void {
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        title: 'Codex',
        activeLeafId: 'pane:1',
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        leafId: 'pane:1',
        paneRuntimeId: 1,
        ptyId,
        paneTitle: null
      }
    ]
  })
}

const TEST_WINDOW_ID = 1
const TEST_REPO_ID = 'repo-1'
const TEST_REPO_PATH = '/tmp/repo'
const TEST_WORKTREE_PATH = '/tmp/worktree-a'
const TEST_WORKTREE_ID = `${TEST_REPO_ID}::${TEST_WORKTREE_PATH}`
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function expectStablePaneKeyEnv(env: Record<string, string>): string {
  expect(env.ORCA_TAB_ID).toMatch(UUID_RE)
  const leafId = env.ORCA_PANE_KEY?.slice(`${env.ORCA_TAB_ID}:`.length)
  expect(leafId).toMatch(UUID_RE)
  expect(env.ORCA_PANE_KEY).toBe(`${env.ORCA_TAB_ID}:${leafId}`)
  return env.ORCA_PANE_KEY
}

function createRuntime(): OrcaRuntimeService {
  return new OrcaRuntimeService(store)
}

function makeWorktreeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const store = {
  getRepo: (id: string) => store.getRepos().find((repo) => repo.id === id),
  getRepos: () => [
    {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1
    }
  ],
  addRepo: () => {},
  updateRepo: (id: string, updates: Record<string, unknown>) =>
    ({
      ...store.getRepo(id),
      ...updates
    }) as never,
  getAllWorktreeMeta: () => ({
    [TEST_WORKTREE_ID]: {
      displayName: 'foo',
      comment: '',
      linkedIssue: 123,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    }
  }),
  getWorktreeMeta: (worktreeId: string) => store.getAllWorktreeMeta()[worktreeId],
  setWorktreeMeta: (_worktreeId: string, meta: Record<string, unknown>) =>
    ({
      ...store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
      ...meta
    }) as never,
  removeWorktreeMeta: () => {},
  getGitHubCache: () => undefined as never,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
}

computeWorktreePathMock.mockImplementation(
  (
    sanitizedName: string,
    repoPath: string,
    settings: { nestWorkspaces: boolean; workspaceDir: string }
  ) => {
    if (settings.nestWorkspaces) {
      const repoName =
        repoPath
          .split(/[\\/]/)
          .at(-1)
          ?.replace(/\.git$/, '') ?? 'repo'
      return `${settings.workspaceDir}/${repoName}/${sanitizedName}`
    }
    return `${settings.workspaceDir}/${sanitizedName}`
  }
)
ensurePathWithinWorkspaceMock.mockImplementation((targetPath: string) => targetPath)

describe('OrcaRuntimeService', () => {
  it('starts unavailable with no authoritative window', () => {
    const runtime = createRuntime()

    expect(runtime.getStatus()).toMatchObject({
      graphStatus: 'unavailable',
      authoritativeWindowId: null,
      rendererGraphEpoch: 0
    })
    expect(runtime.getRuntimeId()).toBeTruthy()
  })

  it('reports runtime protocol, capabilities, and mobile aliases on status', () => {
    const runtime = createRuntime()

    const status = runtime.getStatus()
    expect(typeof status.runtimeProtocolVersion).toBe('number')
    expect(typeof status.minCompatibleRuntimeClientVersion).toBe('number')
    expect(status.runtimeProtocolVersion).toBe(status.protocolVersion)
    expect(status.minCompatibleRuntimeClientVersion).toBe(status.minCompatibleMobileVersion)
    expect(status.capabilities).toContain('terminal.binary-stream.v1')
    expect(typeof status.protocolVersion).toBe('number')
    expect(typeof status.minCompatibleMobileVersion).toBe('number')
    expect(status.protocolVersion).toBeGreaterThanOrEqual(1)
    expect(status.minCompatibleMobileVersion).toBeGreaterThanOrEqual(0)
  })

  it('claims the first window as authoritative and ignores later windows', () => {
    const runtime = createRuntime()

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.attachWindow(2)

    expect(runtime.getStatus().authoritativeWindowId).toBe(TEST_WINDOW_ID)
  })

  it('bumps the epoch and enters reloading when the authoritative window reloads', () => {
    const runtime = createRuntime()

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)
    runtime.markRendererReloading(TEST_WINDOW_ID)

    expect(runtime.getStatus()).toMatchObject({
      graphStatus: 'reloading',
      rendererGraphEpoch: 1
    })
  })

  it('can mark the graph ready for the authoritative window', () => {
    const runtime = createRuntime()

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)
    runtime.markRendererReloading(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    expect(runtime.getStatus().graphStatus).toBe('ready')
  })

  it('drops back to unavailable and clears authority when the window disappears', () => {
    const runtime = createRuntime()

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)
    runtime.markRendererReloading(TEST_WINDOW_ID)
    runtime.markGraphUnavailable(TEST_WINDOW_ID)

    expect(runtime.getStatus()).toMatchObject({
      graphStatus: 'unavailable',
      authoritativeWindowId: null,
      rendererGraphEpoch: 2
    })
  })

  it('stays unavailable during initial loads before a graph is published', () => {
    const runtime = createRuntime()

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markRendererReloading(TEST_WINDOW_ID)

    expect(runtime.getStatus()).toMatchObject({
      graphStatus: 'unavailable',
      rendererGraphEpoch: 0
    })
  })

  it('lists live terminals and issues stable handles for synced leaves', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.onPtyData('pty-1', 'hello from terminal\n', 123)

    const terminals = await runtime.listTerminals('branch:feature/foo')
    expect(terminals.terminals).toHaveLength(1)
    expect(terminals.terminals[0]).toMatchObject({
      worktreeId: 'repo-1::/tmp/worktree-a',
      branch: 'feature/foo',
      title: 'Claude',
      preview: 'hello from terminal'
    })

    const shown = await runtime.showTerminal(terminals.terminals[0].handle)
    expect(shown.handle).toBe(terminals.terminals[0].handle)
    expect(shown.ptyId).toBe('pty-1')
  })

  it('resolves branch selectors when worktrees store refs/heads-prefixed branches', async () => {
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'refs/heads/Jinwoo-H/test-3a',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const runtime = new OrcaRuntimeService(store)

    const worktree = await runtime.showManagedWorktree('branch:Jinwoo-H/test-3a')
    expect(worktree).toMatchObject({
      branch: 'refs/heads/Jinwoo-H/test-3a',
      path: '/tmp/worktree-a'
    })
  })

  it('routes SSH-backed forward-slash UNC file and git paths without collapsing the root', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(new Error('local git should not run for SSH repos'))
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '//Server/Share/Repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '//Server/Share/Repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      })
    }
    const fsProvider = { readDir: vi.fn().mockResolvedValue([]) }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '//Server/Share/Repo',
          head: 'abc',
          branch: 'feature/foo',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      getStatus: vi.fn().mockResolvedValue({
        branch: 'feature/foo',
        files: [],
        ahead: 0,
        behind: 0,
        hasConflicts: false
      })
    }
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    registerSshGitProvider('ssh-1', gitProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await runtime.readFileExplorerDir('path://server/share/repo', 'src')
      await runtime.getRuntimeGitStatus('path://server/share/repo')
      await expect(runtime.showRepo('path://server/share/repo')).resolves.toMatchObject({
        path: '//Server/Share/Repo'
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
      unregisterSshGitProvider('ssh-1')
    }

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(gitProvider.listWorktrees).toHaveBeenCalledWith('//Server/Share/Repo')
    expect(fsProvider.readDir).toHaveBeenCalledWith('\\\\Server\\Share\\Repo\\src')
    expect(gitProvider.getStatus).toHaveBeenCalledWith('//Server/Share/Repo')
  })

  it('does not interpret active as a runtime-global worktree selector', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.showManagedWorktree('active')).rejects.toThrow('selector_not_found')
  })

  it('does not reuse stale in-flight worktree scans after creating a worktree', async () => {
    const runtime = new OrcaRuntimeService(store)
    const staleScan = deferred<typeof MOCK_GIT_WORKTREES>()
    const createdWorktree = {
      path: '/tmp/workspaces/cache-race',
      head: 'def',
      branch: 'cache-race',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(listWorktrees)
      .mockImplementationOnce(() => staleScan.promise)
      .mockResolvedValueOnce([createdWorktree])
      .mockResolvedValueOnce([...MOCK_GIT_WORKTREES, createdWorktree])

    const staleLookup = runtime.showManagedWorktree(TEST_WORKTREE_ID)
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'cache-race'
    })
    const freshLookup = runtime.showManagedWorktree(result.worktree.id)

    staleScan.resolve(MOCK_GIT_WORKTREES)

    await expect(staleLookup).resolves.toMatchObject({ id: TEST_WORKTREE_ID })
    await expect(freshLookup).resolves.toMatchObject({
      id: result.worktree.id,
      path: createdWorktree.path
    })
  })

  it('does not run local git when runtime worktree creation targets an SSH repo', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    const runtime = new OrcaRuntimeService(remoteStore as never)

    await expect(
      runtime.createManagedWorktree({ repoSelector: TEST_REPO_ID, name: 'feature' })
    ).rejects.toThrow('SSH-backed worktree creation is not supported through runtime RPC yet')

    expect(addWorktree).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('removes SSH-backed runtime worktrees through the SSH git provider', async () => {
    vi.mocked(listWorktrees).mockClear()
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      })
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'abc',
          branch: 'feature/foo',
          isBare: false,
          isMainWorktree: true
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await runtime.removeManagedWorktree('path:/remote/repo', true)
    } finally {
      unregisterSshGitProvider('ssh-1')
    }

    expect(gitProvider.removeWorktree).toHaveBeenCalledWith('/remote/repo', true)
    expect(removeWorktree).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('reads SSH repo hooks through the SSH filesystem provider', async () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: 'C:/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  setup: pnpm install\n',
        isBinary: false
      })
    }
    vi.mocked(parseOrcaYaml).mockReturnValue({ scripts: { setup: 'pnpm install' } })
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.getRepoHooks('id:repo-1')).resolves.toMatchObject({
        hasHooksFile: true,
        hooks: { scripts: { setup: 'pnpm install' } },
        source: 'orca.yaml'
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(fsProvider.readFile).toHaveBeenCalledWith('C:\\remote\\repo\\.orca.yaml')
    expect(hasHooksFile).not.toHaveBeenCalled()
    expect(getEffectiveHooks).not.toHaveBeenCalled()
  })

  it('uses remote path joins for SSH hook checks and issue-command files', async () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: 'C:/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    const fsProvider = {
      readFile: vi.fn(async (filePath: string) => ({
        content: filePath.includes('.orca.yaml')
          ? 'scripts:\n  setup: pnpm install\n'
          : filePath.endsWith('.gitignore')
            ? 'node_modules\n'
            : 'Fix it',
        isBinary: false
      })),
      writeFile: vi.fn().mockResolvedValue(undefined),
      createDir: vi.fn().mockResolvedValue(undefined),
      deletePath: vi.fn().mockResolvedValue(undefined)
    }
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.checkRepoHooks('id:repo-1')).resolves.toMatchObject({
        hasHooks: true,
        mayNeedUpdate: false
      })
      await expect(runtime.readRepoIssueCommand('id:repo-1')).resolves.toMatchObject({
        localContent: 'Fix it',
        effectiveContent: 'Fix it',
        localFilePath: 'C:\\remote\\repo\\.orca\\issue-command'
      })
      await expect(runtime.writeRepoIssueCommand('id:repo-1', 'Ship it')).resolves.toEqual({
        ok: true
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(fsProvider.readFile).toHaveBeenCalledWith('C:\\remote\\repo\\.orca.yaml')
    expect(fsProvider.readFile).toHaveBeenCalledWith('C:\\remote\\repo\\.orca\\issue-command')
    expect(fsProvider.createDir).toHaveBeenCalledWith('C:\\remote\\repo\\.orca')
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      'C:\\remote\\repo\\.orca\\issue-command',
      'Ship it\n'
    )
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      'C:\\remote\\repo\\.gitignore',
      'node_modules\n.orca\n'
    )
  })

  it('resolves SSH issue commands from shared orca.yaml and deletes empty overrides', async () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    vi.mocked(parseOrcaYaml).mockReturnValue({
      scripts: {},
      issueCommand: 'claude -p "Fix #{{issue}}"'
    })
    const fsProvider = {
      readFile: vi.fn(async (filePath: string) => {
        if (filePath.endsWith('.orca/issue-command')) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
        if (filePath.endsWith('orca.yaml')) {
          return { content: 'issueCommand: claude -p "Fix #{{issue}}"', isBinary: false }
        }
        return { content: '', isBinary: false }
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      createDir: vi.fn().mockResolvedValue(undefined),
      deletePath: vi.fn().mockResolvedValue(undefined)
    }
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.readRepoIssueCommand('id:repo-1')).resolves.toMatchObject({
        localContent: null,
        sharedContent: 'claude -p "Fix #{{issue}}"',
        effectiveContent: 'claude -p "Fix #{{issue}}"',
        localFilePath: '/remote/repo/.orca/issue-command',
        source: 'shared'
      })
      await expect(runtime.writeRepoIssueCommand('id:repo-1', '   ')).resolves.toEqual({
        ok: true
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(fsProvider.readFile).toHaveBeenCalledWith('/remote/repo/orca.yaml')
    expect(fsProvider.deletePath).toHaveBeenCalledWith('/remote/repo/.orca/issue-command', false)
    expect(fsProvider.writeFile).not.toHaveBeenCalledWith(
      '/remote/repo/.orca/issue-command',
      expect.anything()
    )
  })

  it('rejects host integration helpers for SSH repos instead of using remote paths locally', async () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    const runtime = new OrcaRuntimeService(remoteStore as never)

    await expect(runtime.getRepoSlug('id:repo-1')).rejects.toThrow(
      'repo_slug_unsupported_for_ssh_repo'
    )
    await expect(runtime.listRepoWorkItems('id:repo-1')).rejects.toThrow(
      'repo_work_items_unsupported_for_ssh_repo'
    )
  })

  it('treats SSH worktree drift as unknown without local git probes', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(getDefaultBaseRef).mockClear()
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getWorktreeMeta: () => null
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'abc',
          branch: 'feature/foo',
          isBare: false,
          isMainWorktree: true
        }
      ])
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.probeWorktreeDrift('path:/remote/repo')).resolves.toBeNull()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }

    expect(gitProvider.listWorktrees).toHaveBeenCalledWith('/remote/repo')
    expect(getDefaultBaseRef).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('deduplicates runtime repo paths with Windows/UNC comparison semantics', async () => {
    const added: Record<string, unknown>[] = []
    const uncStore = {
      ...store,
      getRepos: () => [
        {
          id: 'repo-unc',
          path: '//Server/Share/Repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          kind: 'folder'
        },
        ...added
      ],
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => [...uncStore.getRepos()].find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(uncStore as never)

    const repo = await runtime.addRepo('//server/share/repo', 'folder')

    expect(repo).toMatchObject({ id: 'repo-unc', path: '//Server/Share/Repo' })
    expect(added).toHaveLength(0)
  })

  it('associates controller PTYs with mixed-case Windows and UNC cwd paths', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: 'C:\\Repo',
        head: 'abc',
        branch: 'feature/windows',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '//Server/Share/Repo',
        head: 'def',
        branch: 'feature/unc',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'pty-windows', cwd: 'c:\\repo\\src', title: 'Windows shell' },
        { id: 'pty-unc', cwd: '//server/share/repo/src', title: 'UNC shell' }
      ]
    })
    runtime.attachWindow(1)
    runtime.markGraphReady(1)

    const terminals = await runtime.listTerminals()

    expect(terminals.terminals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          worktreeId: `${TEST_REPO_ID}::C:\\Repo`,
          worktreePath: 'C:\\Repo'
        }),
        expect.objectContaining({
          worktreeId: `${TEST_REPO_ID}:://Server/Share/Repo`,
          worktreePath: '//Server/Share/Repo'
        })
      ])
    )
  })

  it('reads bounded terminal output and writes through the PTY controller', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.onPtyData('pty-1', '\u001b[32mhello\u001b[0m\nworld\n', 123)

    const [terminal] = (await runtime.listTerminals()).terminals
    const read = await runtime.readTerminal(terminal.handle)
    expect(read).toMatchObject({
      handle: terminal.handle,
      status: 'running',
      tail: ['hello', 'world'],
      truncated: false,
      nextCursor: expect.any(String)
    })

    const send = await runtime.sendTerminal(terminal.handle, {
      text: 'continue',
      enter: true
    })
    expect(send).toMatchObject({
      handle: terminal.handle,
      accepted: true
    })
    expect(writes).toEqual(['continue', '\r'])
  })

  it('creates visible terminal sessions without asking the renderer to focus a tab', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const createTerminal = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal,
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const result = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      title: 'worker'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: TEST_WORKTREE_PATH,
        command: 'codex',
        worktreeId: TEST_WORKTREE_ID,
        preAllocatedHandle: expect.stringMatching(/^term_/)
      })
    )
    expect(result).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      title: 'worker',
      surface: 'visible'
    })
    expect(result.handle).toMatch(/^term_/)
    expect(createTerminal).not.toHaveBeenCalled()
    // Why: hook-based agent status keys off `${tabId}:${leafId}`, so main must
    // pre-allocate the tabId and stamp ORCA_PANE_KEY/TAB_ID/WORKTREE_ID into
    // the PTY env before spawn. The same tabId is then handed to the renderer
    // via `revealTerminalSession` so adoption preserves attribution.
    const spawnCall = spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined
    const spawnedEnv = spawnCall?.env ?? {}
    expectStablePaneKeyEnv(spawnedEnv)
    const spawnedLeafId = spawnedEnv.ORCA_PANE_KEY.slice(`${spawnedEnv.ORCA_TAB_ID}:`.length)
    expect(spawnedEnv.ORCA_WORKTREE_ID).toBe(TEST_WORKTREE_ID)
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
      ptyId: 'pty-bg',
      title: 'worker',
      activate: false,
      tabId: spawnedEnv.ORCA_TAB_ID,
      leafId: spawnedLeafId
    })
  })

  it('adopts renderer pane identity for remote runtime terminal creates', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-remote-runtime'
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      focus: false,
      tabId,
      leafId,
      env: {
        ORCA_PANE_KEY: `${tabId}:${leafId}`,
        ORCA_TAB_ID: tabId
      }
    })

    const spawnedEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expect(spawnedEnv.ORCA_TAB_ID).toBe(tabId)
    expect(spawnedEnv.ORCA_PANE_KEY).toBe(`${tabId}:${leafId}`)
  })

  it('creates background terminal sessions while the renderer graph is unavailable', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)).resolves.toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      surface: 'background'
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: TEST_WORKTREE_ID
      })
    )
  })

  it('returns a background handle when inactive tab adoption fails after spawn', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const revealTerminalSession = vi.fn().mockRejectedValue(new Error('Renderer timed out'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    try {
      await expect(runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)).resolves.toMatchObject({
        worktreeId: TEST_WORKTREE_ID,
        surface: 'background',
        handle: expect.stringMatching(/^term_/)
      })
      const spawnCall = spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined
      const spawnedEnv = spawnCall?.env ?? {}
      expectStablePaneKeyEnv(spawnedEnv)
      const spawnedLeafId = spawnedEnv.ORCA_PANE_KEY.slice(`${spawnedEnv.ORCA_TAB_ID}:`.length)
      expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
        ptyId: 'pty-bg',
        title: null,
        activate: false,
        tabId: spawnedEnv.ORCA_TAB_ID,
        leafId: spawnedLeafId
      })
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[terminal-create] failed to create inactive tab for pty-bg:'),
        expect.any(Error)
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('waits for exit on background terminal handles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    const waiting = runtime.waitForTerminal(handle, { condition: 'exit', timeoutMs: 1000 })
    runtime.onPtyExit('pty-bg', 7)

    await expect(waiting).resolves.toMatchObject({
      handle,
      condition: 'exit',
      status: 'exited',
      exitCode: 7
    })
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      status: 'exited'
    })
  })

  it('splits text and enter writes for background terminal handles', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    await runtime.sendTerminal(handle, { text: 'continue', enter: true })

    expect(writes).toEqual(['continue', '\r'])
  })

  it('reveals a background terminal session when focusing its handle', async () => {
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-adopted' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      title: 'worker'
    })

    await expect(runtime.focusTerminal(handle)).resolves.toMatchObject({
      handle,
      tabId: 'tab-adopted',
      worktreeId: TEST_WORKTREE_ID
    })
    // Why: createTerminal first reveal stamps activate/tabId; the focus reveal
    // is the second call and must reuse that pre-minted tabId so a retry after
    // an earlier reveal failure still adopts under the paneKey baked into env.
    expect(revealTerminalSession).toHaveBeenLastCalledWith(TEST_WORKTREE_ID, {
      ptyId: 'pty-bg',
      title: 'worker',
      tabId: expect.stringMatching(UUID_RE),
      leafId: expect.stringMatching(UUID_RE)
    })
  })

  it('rejects focusing an exited background terminal session', async () => {
    const revealTerminalSession = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    revealTerminalSession.mockClear()
    runtime.onPtyExit('pty-bg', 0)

    await expect(runtime.focusTerminal(handle)).rejects.toThrow('terminal_exited')
    expect(revealTerminalSession).not.toHaveBeenCalled()
  })

  it('renames background terminal handles without requiring a visible tab', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    await expect(runtime.renameTerminal(handle, 'Worker')).resolves.toMatchObject({
      handle,
      tabId: 'pty:pty-bg',
      title: 'Worker'
    })
    await expect(runtime.showTerminal(handle)).resolves.toMatchObject({
      title: 'Worker'
    })
  })

  it('keeps a background terminal handle stable while reveal adoption is racing', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      title: 'worker'
    })

    await runtime.focusTerminal(handle)
    ;(runtime as unknown as { handleByPtyId: Map<string, string> }).handleByPtyId.delete('pty-bg')

    await expect(runtime.showTerminal(handle)).resolves.toMatchObject({
      handle,
      ptyId: 'pty-bg'
    })
  })

  it('clears terminal scrollback through the PTY controller and headless buffer', async () => {
    const clearBuffer = vi.fn().mockResolvedValue(undefined)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      clearBuffer
    })
    syncSinglePty(runtime, 'pty-1')

    runtime.onPtyData(
      'pty-1',
      `${Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n')}\n`,
      123
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.clearTerminalBuffer(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      cleared: true
    })

    expect(clearBuffer).toHaveBeenCalledWith('pty-1')
    const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    expect(snapshot?.data).not.toContain('line-0')
  })

  it('waits for terminal exit and resolves with the exit status', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals
    const waitPromise = runtime.waitForTerminal(terminal.handle, { timeoutMs: 1000 })
    runtime.onPtyExit('pty-1', 7)

    await expect(waitPromise).resolves.toMatchObject({
      handle: terminal.handle,
      condition: 'exit',
      satisfied: true,
      status: 'exited',
      exitCode: 7
    })
  })

  it('keeps partial-line output readable across cursor-based pagination', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'hel', 100)

    // Non-cursor reads include the partial line for UI display
    const firstRead = await runtime.readTerminal(terminal.handle)
    expect(firstRead.tail).toEqual(['hel'])
    expect(firstRead.nextCursor).toBe('0')

    runtime.onPtyData('pty-1', 'lo', 101)

    // Cursor-based reads exclude partial lines to prevent duplication:
    // without this, the consumer would see "hello" now as a partial, then
    // see "hello" again as a completed line on the next read.
    const secondRead = await runtime.readTerminal(terminal.handle, {
      cursor: Number(firstRead.nextCursor)
    })
    expect(secondRead.tail).toEqual([])
    expect(secondRead.nextCursor).toBe('0')

    runtime.onPtyData('pty-1', '\nworld\n', 102)

    const thirdRead = await runtime.readTerminal(terminal.handle, {
      cursor: Number(secondRead.nextCursor)
    })
    expect(thirdRead.tail).toEqual(['hello', 'world'])
    expect(thirdRead.nextCursor).toBe('2')
  })

  it('delivers pending orchestration messages to an already-idle agent', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new OrchestrationDb(':memory:')
      const write = vi.fn().mockReturnValue(true)
      runtime.setOrchestrationDb(db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      db.insertMessage({ from: 'term_sender', to: terminal.handle, subject: 'hello' })

      runtime.deliverPendingMessagesForHandle(terminal.handle)

      expect(write).toHaveBeenCalledWith('pty-1', expect.stringContaining('Subject: hello'))
      // Why: the split Enter write lands after the 500ms delay, so we advance
      // past it before asserting on delivered_at.
      await vi.advanceTimersByTimeAsync(500)
      expect(write).toHaveBeenCalledWith('pty-1', '\r')

      // Why: design doc §3.2 splits delivered vs. read — push-on-idle stamps
      // `delivered_at` but must *not* flip `read`, since only the check caller
      // (the agent) is authorized to consume messages from its queue. The
      // injected banner is a courtesy; the rows stay unread so the agent can
      // still observe them via `check` and resolve the consumption race.
      const unread = db.getUnreadMessages(terminal.handle)
      expect(unread).toHaveLength(1)
      expect(unread[0].read).toBe(0)
      expect(unread[0].delivered_at).not.toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not replay an already-delivered message on a later idle transition', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new OrchestrationDb(':memory:')
      const write = vi.fn().mockReturnValue(true)
      runtime.setOrchestrationDb(db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      db.insertMessage({ from: 'term_sender', to: terminal.handle, subject: 'hello' })

      runtime.deliverPendingMessagesForHandle(terminal.handle)
      await vi.advanceTimersByTimeAsync(500)

      const firstInjections = write.mock.calls.filter(
        (c) => typeof c[1] === 'string' && c[1].includes('Subject: hello')
      ).length
      expect(firstInjections).toBe(1)

      // Second idle transition: the row is still unread (no check caller has
      // consumed it), but it has been delivered. Push-on-idle must skip it to
      // avoid the replay bug.
      runtime.deliverPendingMessagesForHandle(terminal.handle)
      await vi.advanceTimersByTimeAsync(500)

      const totalInjections = write.mock.calls.filter(
        (c) => typeof c[1] === 'string' && c[1].includes('Subject: hello')
      ).length
      expect(totalInjections).toBe(1)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('adopts preallocated ORCA_TERMINAL_HANDLE as a valid runtime handle', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', 'ready\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.handle).toBe(handle)
    expect(read.tail).toEqual(['ready'])
  })

  it('keeps preallocated terminal handles valid across renderer reloads', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.markRendererReloading(1)
    syncSinglePty(runtime, null)
    runtime.onPtyData('pty-1', 'after reload\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.tail).toEqual(['after reload'])
  })

  it('keeps preallocated terminal handles valid when a reload graph omits the live leaf', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.markRendererReloading(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: []
    })
    runtime.onPtyData('pty-1', 'after omitted leaf\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.tail).toEqual(['after omitted leaf'])
  })

  it('keeps preallocated terminal handles valid after graph unavailable during reload', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.markGraphUnavailable(1)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: []
    })
    runtime.onPtyData('pty-1', 'after unavailable\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.tail).toEqual(['after unavailable'])
  })

  it('keeps runtime-created PTY handles valid after graph unavailable', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    runtime.markGraphUnavailable(1)
    runtime.onPtyData('pty-bg', 'after unavailable\n', 100)

    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      handle,
      tail: ['after unavailable']
    })
    await expect(runtime.sendTerminal(handle, { text: 'still writable' })).resolves.toMatchObject({
      handle,
      accepted: true
    })
    expect(writes).toEqual(['still writable'])
  })

  it('keeps mobile terminal surfaces visible while their leaf handle is pending', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: 'tab-1::pane:1',
        parentTabId: 'tab-1',
        leafId: 'pane:1',
        status: 'pending-handle',
        terminal: null
      })
    ])
  })

  it('resolves mobile terminal surfaces by exact split leaf', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:2',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'left'
        },
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:2',
          paneRuntimeId: 2,
          ptyId: 'pty-2',
          paneTitle: 'right'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:2',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              isActive: false
            },
            {
              type: 'terminal',
              id: 'tab-1::pane:2',
              parentTabId: 'tab-1',
              leafId: 'pane:2',
              title: 'Terminal 1',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toHaveLength(2)
    expect(result.tabs).toEqual([
      expect.objectContaining({ id: 'tab-1::pane:1', title: 'left', status: 'ready' }),
      expect.objectContaining({ id: 'tab-1::pane:2', title: 'right', status: 'ready' })
    ])
    const [left, right] = result.tabs
    expect(left?.type).toBe('terminal')
    expect(right?.type).toBe('terminal')
    if (left?.type === 'terminal' && right?.type === 'terminal') {
      expect(left.terminal).not.toBe(right.terminal)
    }
  })

  it('closes the matching mobile terminal UUID leaf without closing the whole tab', async () => {
    const closeTerminal = vi.fn()
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(),
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal,
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    const leftLeafId = '11111111-1111-4111-8111-111111111111'
    const rightLeafId = '22222222-2222-4222-8222-222222222222'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: rightLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: leftLeafId,
          paneRuntimeId: 1,
          ptyId: 'pty-left',
          paneTitle: 'left'
        },
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: rightLeafId,
          paneRuntimeId: 2,
          ptyId: 'pty-right',
          paneTitle: 'right'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `tab-1::${rightLeafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${rightLeafId}`,
              parentTabId: 'tab-1',
              leafId: rightLeafId,
              title: 'right',
              isActive: true
            }
          ]
        }
      ]
    })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, `tab-1::${rightLeafId}`)

    expect(kill).toHaveBeenCalledWith('pty-right')
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('creates mobile session terminals in a headless runtime server', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-headless' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const result = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`)

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        preAllocatedHandle: expect.stringMatching(/^term_/)
      })
    )
    expect(result.tab).toMatchObject({
      type: 'terminal',
      status: 'ready',
      terminal: expect.stringMatching(/^term_/),
      isActive: true
    })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabs).toEqual([
      expect.objectContaining({
        id: result.tab.id,
        status: 'ready',
        terminal: result.tab.terminal
      })
    ])
  })

  it('reports browser tab creation as unsupported for headless runtime servers', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.browserTabCreate({ worktree: `id:${TEST_WORKTREE_ID}`, url: 'https://example.com' })
    ).rejects.toMatchObject({
      code: 'browser_error',
      message: expect.stringContaining('headless orca serve')
    })
  })

  it('keeps already-idle status after tui-idle wait for immediate message delivery', async () => {
    const runtime = new OrcaRuntimeService(store)
    const db = new OrchestrationDb(':memory:')
    const write = vi.fn().mockReturnValue(true)
    runtime.setOrchestrationDb(db)
    runtime.setPtyController({
      write,
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
    await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
    db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'after wait' })

    runtime.deliverPendingMessagesForHandle(terminal.handle)

    expect(write).toHaveBeenCalledWith('pty-1', expect.stringContaining('Subject: after wait'))
    db.close()
  })

  it('resolves message waiters when notifyMessageArrived is called', async () => {
    const runtime = new OrcaRuntimeService(store)

    const waitPromise = runtime.waitForMessage('term_abc', { timeoutMs: 5000 })
    runtime.notifyMessageArrived('term_abc')
    await waitPromise
  })

  it('resolves message waiters on timeout when no message arrives', async () => {
    const runtime = new OrcaRuntimeService(store)

    const start = Date.now()
    await runtime.waitForMessage('term_abc', { timeoutMs: 100 })
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(90)
    expect(elapsed).toBeLessThan(500)
  })

  it('fails terminal waits closed when the handle goes stale during reload', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals
    const waitPromise = runtime.waitForTerminal(terminal.handle, { timeoutMs: 1000 })
    runtime.markRendererReloading(1)

    await expect(waitPromise).rejects.toThrow('terminal_handle_stale')
  })

  it('tui-idle times out when PTY data has no agent OSC title transitions', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)

      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo-1::/tmp/worktree-a',
            title: 'Terminal 1',
            activeLeafId: 'pane:1',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo-1::/tmp/worktree-a',
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'pty-1'
          }
        ]
      })
      runtime.onPtyData('pty-1', 'running migration step 4/9\n', 123)

      const [terminal] = (await runtime.listTerminals()).terminals
      const waitPromise = runtime.waitForTerminal(terminal.handle, {
        condition: 'tui-idle',
        timeoutMs: 1_000
      })
      const timeoutAssertion = expect(waitPromise).rejects.toThrow('timeout')

      await vi.advanceTimersByTimeAsync(12_000)

      await timeoutAssertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('tui-idle resolves on agent working→idle OSC title transition', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    // Simulate agent starting work (braille spinner = working)
    runtime.onPtyData('pty-1', '\x1b]0;\u280b Working on task\x07output\n', 100)

    const [terminal] = (await runtime.listTerminals()).terminals
    const waitPromise = runtime.waitForTerminal(terminal.handle, {
      condition: 'tui-idle',
      timeoutMs: 5_000
    })

    // Simulate agent finishing (✳ = Claude Code idle)
    runtime.onPtyData('pty-1', '\x1b]0;\u2733 Task complete\x07done\n', 200)

    const result = await waitPromise
    expect(result.condition).toBe('tui-idle')
    expect(result.satisfied).toBe(true)
  })

  it('builds a compact worktree summary from persisted and live runtime state', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.onPtyData('pty-1', 'build green\n', 321)

    const summaries = await runtime.getWorktreePs()
    expect(summaries).toEqual({
      worktrees: [
        {
          worktreeId: 'repo-1::/tmp/worktree-a',
          repoId: 'repo-1',
          repo: 'repo',
          path: '/tmp/worktree-a',
          branch: 'feature/foo',
          parentWorktreeId: null,
          childWorktreeIds: [],
          displayName: 'foo',
          linkedIssue: 123,
          linkedPR: null,
          isPinned: false,
          status: 'active',
          unread: false,
          liveTerminalCount: 1,
          hasAttachedPty: true,
          lastOutputAt: 321,
          preview: 'build green'
        }
      ],
      totalCount: 1,
      truncated: false
    })
  })

  it('clears stale working status after the agent exits and the shell takes over the title', async () => {
    // Why: regression test for issue #1437 — the mobile worktree-list spinner
    // kept playing forever because lastAgentStatus was sticky on 'working'
    // once an agent exited without emitting an idle/agent-shaped final OSC
    // title. worktree.ps must recompute from the live OSC title each call.
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Codex working',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    const working = await runtime.getWorktreePs()
    expect(working.worktrees[0].status).toBe('working')

    // Agent exits, shell title takes over — desktop's getWorktreeStatus would
    // immediately flip back to 'active'. Mobile must do the same.
    runtime.onPtyData('pty-1', '\x1b]0;bash\x07', 200)
    const afterExit = await runtime.getWorktreePs()
    expect(afterExit.worktrees[0].status).toBe('active')
  })

  it('fails terminal stop closed while the renderer graph is reloading', async () => {
    const runtime = new OrcaRuntimeService(store)
    let killed = false
    runtime.setPtyController({
      write: () => true,
      kill: () => {
        killed = true
        return true
      },
      getForegroundProcess: async () => null
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.markRendererReloading(1)

    await expect(runtime.stopTerminalsForWorktree('id:repo-1::/tmp/worktree-a')).rejects.toThrow(
      'runtime_unavailable'
    )
    expect(killed).toBe(false)
  })

  it('fails terminal listing closed if the graph reloads during selector resolution', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    let releaseListWorktrees = () => {}
    vi.mocked(listWorktrees).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseListWorktrees = () => resolve(MOCK_GIT_WORKTREES)
        })
    )

    const listPromise = runtime.listTerminals('branch:feature/foo')
    runtime.markRendererReloading(1)
    releaseListWorktrees()

    await expect(listPromise).rejects.toThrow('runtime_unavailable')
  })

  it('fails terminal stop closed if the graph reloads during selector resolution', async () => {
    const runtime = new OrcaRuntimeService(store)
    let killed = false
    runtime.setPtyController({
      write: () => true,
      kill: () => {
        killed = true
        return true
      },
      getForegroundProcess: async () => null
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    let releaseListWorktrees = () => {}
    vi.mocked(listWorktrees).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseListWorktrees = () => resolve(MOCK_GIT_WORKTREES)
        })
    )

    const stopPromise = runtime.stopTerminalsForWorktree('branch:feature/foo')
    runtime.markRendererReloading(1)
    releaseListWorktrees()

    await expect(stopPromise).rejects.toThrow('runtime_unavailable')
    expect(killed).toBe(false)
  })

  it('rejects invalid positive limits for bounded list commands', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.getWorktreePs(-1)).rejects.toThrow('invalid_limit')
    await expect(runtime.listManagedWorktrees(undefined, 0)).rejects.toThrow('invalid_limit')
    await expect(runtime.searchRepoRefs('id:repo-1', 'main', -5)).rejects.toThrow('invalid_limit')
  })

  it('resolves SSH worktrees when manually updating lineage', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const childId = `${remoteRepo.id}::/home/user/repo-child`
    const parentId = `${remoteRepo.id}::/home/user/repo-parent`
    const metaById: Record<string, WorktreeMeta> = {
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' }),
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' })
    }
    const setWorktreeLineage = vi.fn((_worktreeId, lineage) => lineage)
    const listSshWorktrees = vi.fn().mockResolvedValue([
      {
        path: '/home/user/repo-child',
        head: 'abc',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: '/home/user/repo-parent',
        head: 'def',
        branch: 'feature/parent',
        isBare: false,
        isMainWorktree: false
      }
    ])
    getSshGitProviderMock.mockReturnValue({ listWorktrees: listSshWorktrees })
    const runtimeStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(listSshWorktrees).toHaveBeenCalledWith(remoteRepo.path)
    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual'
      })
    )
  })

  it('ignores stale instance-mismatched lineage when validating manual cycle repairs', async () => {
    const parentPath = '/tmp/worktree-a'
    const childPath = '/tmp/worktree-b'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'new-parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const setWorktreeLineage = vi.fn((_worktreeId, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: (worktreeId: string) =>
        worktreeId === parentId
          ? {
              worktreeId: parentId,
              worktreeInstanceId: 'old-parent-instance',
              parentWorktreeId: childId,
              parentWorktreeInstanceId: 'child-instance',
              origin: 'manual' as const,
              capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
              createdAt: 1
            }
          : undefined,
      setWorktreeLineage
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: parentPath,
        head: 'abc',
        branch: 'feature/a',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: childPath,
        head: 'def',
        branch: 'feature/b',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'new-parent-instance'
      })
    )
  })

  it('backfills instanceId during runtime selector resolution for upgraded metadata', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta(),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = {
          ...metaById[worktreeId],
          ...meta,
          instanceId: meta.instanceId ?? metaById[worktreeId]?.instanceId ?? 'backfilled-instance'
        }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage: vi.fn((_worktreeId: string, lineage) => lineage)
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: parentPath,
        head: 'abc',
        branch: 'feature/parent',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: childPath,
        head: 'def',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(runtimeStore.setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeInstanceId: 'child-instance',
        parentWorktreeInstanceId: 'backfilled-instance'
      })
    )
  })

  it('rotates a missing parent instance during runtime selector scans before same-path reuse', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'old-parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'old-parent-instance',
        origin: 'manual' as const,
        capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
        createdAt: 1
      }
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: (worktreeId: string) => lineageById[worktreeId],
      getAllWorktreeLineage: () => lineageById,
      removeWorktreeLineage: vi.fn((worktreeId: string) => {
        delete lineageById[worktreeId]
      }),
      setWorktreeLineage
    }
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'feature/child',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValue([
        {
          path: childPath,
          head: 'def',
          branch: 'feature/child',
          isBare: false,
          isMainWorktree: false
        },
        {
          path: parentPath,
          head: 'abc',
          branch: 'feature/parent',
          isBare: false,
          isMainWorktree: false
        }
      ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.showManagedWorktree(`id:${childId}`)
    const rotatedParentInstance = metaById[parentId].instanceId
    expect(rotatedParentInstance).toBeTruthy()
    expect(rotatedParentInstance).not.toBe('old-parent-instance')
    await runtime.updateManagedWorktreeMeta(`id:${childId}`, { comment: 'rescanned' })
    expect(metaById[parentId].instanceId).toBe(rotatedParentInstance)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, { comment: 'touch' })
    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeInstanceId: 'child-instance',
        parentWorktreeInstanceId: rotatedParentInstance
      })
    )
  })

  it('does not prune lineage when a runtime local worktree scan fails', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const removeWorktreeLineage = vi.fn((worktreeId: string) => {
      delete lineageById[worktreeId]
    })
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      }),
      getAllWorktreeLineage: () => lineageById,
      removeWorktreeLineage
    }
    vi.mocked(listWorktrees).mockRejectedValueOnce(new Error('git unavailable'))
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.showManagedWorktree(`id:${childId}`)).rejects.toThrow('selector_not_found')

    expect(removeWorktreeLineage).not.toHaveBeenCalled()
    expect(runtimeStore.setWorktreeMeta).not.toHaveBeenCalled()
    expect(lineageById[childId]).toBeTruthy()
    expect(metaById[parentId].instanceId).toBe('parent-instance')
  })

  it('does not prune lineage when an SSH runtime provider is unavailable', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const parentId = `${remoteRepo.id}::/home/user/repo-parent`
    const childId = `${remoteRepo.id}::/home/user/repo-child`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const removeWorktreeLineage = vi.fn((worktreeId: string) => {
      delete lineageById[worktreeId]
    })
    const runtimeStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      }),
      getAllWorktreeLineage: () => lineageById,
      removeWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.showManagedWorktree(`id:${childId}`)).rejects.toThrow('selector_not_found')

    expect(removeWorktreeLineage).not.toHaveBeenCalled()
    expect(runtimeStore.setWorktreeMeta).not.toHaveBeenCalled()
    expect(lineageById[childId]).toBeTruthy()
    expect(metaById[parentId].instanceId).toBe('parent-instance')
  })

  it('exposes valid parent and child lineage in CLI worktree records', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({
        instanceId: 'parent-instance',
        displayName: 'parent'
      }),
      [childId]: makeWorktreeMeta({
        instanceId: 'child-instance',
        displayName: 'child'
      })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getAllWorktreeLineage: () => lineageById
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: parentPath,
        head: 'abc',
        branch: 'feature/parent',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: childPath,
        head: 'def',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const listed = await runtime.listManagedWorktrees('id:repo-1')
    const parent = listed.worktrees.find((worktree) => worktree.id === parentId)
    const child = listed.worktrees.find((worktree) => worktree.id === childId)

    expect(parent).toMatchObject({
      parentWorktreeId: null,
      childWorktreeIds: [childId],
      lineage: null
    })
    expect(child).toMatchObject({
      parentWorktreeId: parentId,
      childWorktreeIds: [],
      lineage: lineageById[childId]
    })
    await expect(runtime.showManagedWorktree(`id:${childId}`)).resolves.toMatchObject({
      id: childId,
      parentWorktreeId: parentId,
      childWorktreeIds: [],
      lineage: lineageById[childId]
    })
  })

  it('keeps valid orchestration lineage when caller terminal context is stale', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/workspaces/worker-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({
        instanceId: 'parent-instance',
        displayName: 'coordinator'
      })
    }
    const setWorktreeLineage = vi.fn((worktreeId: string, lineage) => {
      metaById[worktreeId] = metaById[worktreeId] ?? makeWorktreeMeta()
      return lineage
    })
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existing = metaById[worktreeId] ?? makeWorktreeMeta({ instanceId: 'child-instance' })
        metaById[worktreeId] = { ...existing, ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: parentPath,
          head: 'abc',
          branch: 'feature/coordinator',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'worker-child',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'worker-child',
      lineage: {
        callerTerminalHandle: 'term_stale',
        orchestrationContext: {
          parentWorktreeId: parentId,
          orchestrationRunId: 'run-1',
          taskId: 'task-1',
          coordinatorHandle: 'term_coord'
        }
      }
    })

    expect(result.lineage).toMatchObject({
      worktreeId: childId,
      parentWorktreeId: parentId,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' },
      orchestrationRunId: 'run-1',
      taskId: 'task-1',
      coordinatorHandle: 'term_coord'
    })
    expect(result.lineage).not.toHaveProperty('createdByTerminalHandle')
    expect(result.warnings).toEqual([])
    expect(setWorktreeLineage).toHaveBeenCalledWith(childId, expect.any(Object))
  })

  it('enriches caller-terminal lineage with active orchestration dispatch context', async () => {
    const workerPath = '/tmp/worktree-worker'
    const childPath = '/tmp/workspaces/worker-child'
    const childId = `${TEST_REPO_ID}::${childPath}`
    const workerId = `${TEST_REPO_ID}::${workerPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({
        instanceId: 'parent-instance',
        displayName: 'coordinator'
      }),
      [workerId]: makeWorktreeMeta({
        instanceId: 'worker-instance',
        displayName: 'worker'
      })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existing = metaById[worktreeId] ?? makeWorktreeMeta()
        metaById[worktreeId] = { ...existing, ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
    const coordinatorHandle = runtime.preAllocateHandleForPty('pty-coordinator')
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: vi.fn(() => ({
        task_id: 'task-1'
      })),
      getActiveCoordinatorRun: vi.fn(() => ({
        id: 'run-1',
        coordinator_handle: coordinatorHandle
      }))
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: workerId,
          title: 'Worker',
          activeLeafId: 'pane:1',
          layout: null
        },
        {
          tabId: 'tab-coordinator',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Coordinator',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: workerId,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        },
        {
          tabId: 'tab-coordinator',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 2,
          ptyId: 'pty-coordinator',
          paneTitle: null
        }
      ]
    })
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        ...MOCK_GIT_WORKTREES,
        {
          path: workerPath,
          head: 'fed',
          branch: 'feature/worker',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'worker-child',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'worker-child',
      lineage: { callerTerminalHandle: workerHandle }
    })

    expect(result.lineage).toMatchObject({
      worktreeId: childId,
      parentWorktreeId: workerId,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' },
      orchestrationRunId: 'run-1',
      taskId: 'task-1',
      coordinatorHandle,
      createdByTerminalHandle: workerHandle
    })
    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeInstanceId: expect.not.stringMatching(/^old-/),
        parentWorktreeInstanceId: 'worker-instance'
      })
    )
  })

  it('falls back to cwd lineage when the caller terminal handle is stale', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/workspaces/cwd-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existing = metaById[worktreeId] ?? makeWorktreeMeta()
        metaById[worktreeId] = { ...existing, ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: parentPath,
          head: 'abc',
          branch: 'feature/parent',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'cwd-child',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'cwd-child',
      lineage: {
        callerTerminalHandle: 'term_stale',
        cwdParentWorktree: `id:${parentId}`
      }
    })

    expect(result.lineage).toMatchObject({
      worktreeId: childId,
      parentWorktreeId: parentId,
      origin: 'cli',
      capture: { source: 'cwd-context', confidence: 'inferred' }
    })
    expect(result.worktree).toMatchObject({
      parentWorktreeId: parentId,
      childWorktreeIds: [],
      lineage: result.lineage
    })
    expect(setWorktreeLineage).toHaveBeenCalledWith(childId, expect.any(Object))
  })

  it('keeps cwd-inferred lineage best-effort when the cwd parent cannot be resolved', async () => {
    const childPath = '/tmp/workspaces/no-cwd-parent'
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce(MOCK_GIT_WORKTREES)
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'no-cwd-parent',
          isBare: false,
          isMainWorktree: false
        }
      ])
    const runtime = new OrcaRuntimeService(store)

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'no-cwd-parent',
      lineage: {
        cwdParentWorktree: 'id:repo-1::/tmp/missing-parent'
      }
    })

    expect(result.lineage).toBeNull()
    expect(result.worktree).toMatchObject({
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null
    })
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'LINEAGE_PARENT_CONTEXT_MISSING',
        message:
          'Worktree created, but Orca could not validate the current directory as a parent workspace.'
      })
    ])
  })

  it('infers orchestration lineage from task-id comments when dispatch is completed', async () => {
    const workerPath = '/tmp/worktree-worker'
    const childPath = '/tmp/workspaces/worker-child'
    const childId = `${TEST_REPO_ID}::${childPath}`
    const workerId = `${TEST_REPO_ID}::${workerPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [workerId]: makeWorktreeMeta({
        instanceId: 'worker-instance',
        displayName: 'worker'
      })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existing = metaById[worktreeId] ?? makeWorktreeMeta()
        metaById[worktreeId] = { ...existing, ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
    runtime.setOrchestrationDb({
      getDispatchContext: vi.fn(() => ({
        task_id: 'task_abc123',
        assignee_handle: workerHandle,
        status: 'completed'
      }))
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: workerId,
          title: 'Worker',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: workerId,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        }
      ]
    })
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: workerPath,
          head: 'fed',
          branch: 'feature/worker',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'worker-child',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'worker-child',
      comment: 'Created via orchestration task task_abc123'
    })

    expect(result.lineage).toMatchObject({
      worktreeId: childId,
      parentWorktreeId: workerId,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' },
      taskId: 'task_abc123'
    })
    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        parentWorktreeInstanceId: 'worker-instance'
      })
    )
  })

  it('infers orchestration lineage from task creator when no dispatch context exists', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/workspaces/parent-child'
    const childId = `${TEST_REPO_ID}::${childPath}`
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({
        instanceId: 'parent-instance',
        displayName: 'parent'
      })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existing = metaById[worktreeId] ?? makeWorktreeMeta()
        metaById[worktreeId] = { ...existing, ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const parentHandle = runtime.preAllocateHandleForPty('pty-parent')
    runtime.setOrchestrationDb({
      getDispatchContext: vi.fn(() => undefined),
      getTask: vi.fn(() => ({
        id: 'task_creator123',
        created_by_terminal_handle: parentHandle
      }))
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-parent',
          worktreeId: parentId,
          title: 'Parent',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-parent',
          worktreeId: parentId,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-parent',
          paneTitle: null
        }
      ]
    })
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: parentPath,
          head: 'fed',
          branch: 'feature/parent',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'parent-child',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'parent-child',
      comment: 'Created via orchestration task task_creator123'
    })

    expect(result.lineage).toMatchObject({
      worktreeId: childId,
      parentWorktreeId: parentId,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' },
      taskId: 'task_creator123'
    })
    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        parentWorktreeInstanceId: 'parent-instance'
      })
    )
  })

  it('returns a setup launch payload for CLI-created worktrees when hooks are explicitly enabled', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hook-test')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hook-test')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-test'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/runtime-hook-test',
        head: 'def',
        branch: 'runtime-hook-test',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-test',
      runHooks: true
    })

    expect(createSetupRunnerScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1', path: '/tmp/repo' }),
      '/tmp/workspaces/runtime-hook-test',
      'pnpm worktree:setup'
    )
    expect(runHook).not.toHaveBeenCalled()
    expect(addWorktree).toHaveBeenCalledWith(
      '/tmp/repo',
      '/tmp/workspaces/runtime-hook-test',
      'runtime-hook-test',
      'origin/main',
      false
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        repoId: 'repo-1',
        path: '/tmp/workspaces/runtime-hook-test',
        branch: 'runtime-hook-test'
      }),
      setup: {
        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
        envVars: {
          ORCA_ROOT_PATH: '/tmp/repo',
          ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-test'
        }
      }
    })
    expect(activateWorktree).toHaveBeenCalledWith('repo-1', expect.any(String), result.setup)
  })

  it('passes setup payloads through when explicitly activating CLI-created worktrees', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hook-activate')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hook-activate')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-activate'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/runtime-hook-activate',
        head: 'def',
        branch: 'runtime-hook-activate',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-activate',
      runHooks: true,
      activate: true
    })

    expect(activateWorktree).toHaveBeenCalledWith('repo-1', expect.any(String), result.setup)
  })

  it('follows normal setup policy for CLI-created worktrees without activating them', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-created-worktree' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-primary' })
      .mockResolvedValueOnce({ id: 'pty-setup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hook-skip')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hook-skip')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-skip'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-hook-skip',
        head: 'def',
        branch: 'runtime-hook-skip',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-skip'
    })

    expect(createSetupRunnerScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1', path: '/tmp/repo' }),
      '/tmp/workspaces/runtime-hook-skip',
      'pnpm worktree:setup'
    )
    expect(runHook).not.toHaveBeenCalled()
    expect(result).toEqual({
      worktree: expect.objectContaining({
        repoId: 'repo-1',
        path: '/tmp/workspaces/runtime-hook-skip',
        branch: 'runtime-hook-skip'
      }),
      setup: {
        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
        envVars: {
          ORCA_ROOT_PATH: '/tmp/repo',
          ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-skip'
        }
      }
    })
    expect(activateWorktree).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-hook-skip',
        command: undefined,
        worktreeId: result.worktree.id
      })
    )
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-hook-skip',
        command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
        // Why: createTerminal stamps ORCA_PANE_KEY/TAB_ID/WORKTREE_ID into the
        // PTY env on top of the caller-supplied env so hook-based agent status
        // can attribute hook events to a stable pane.
        env: expect.objectContaining({
          ORCA_ROOT_PATH: '/tmp/repo',
          ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-skip',
          ORCA_TAB_ID: expect.stringMatching(UUID_RE),
          ORCA_PANE_KEY: expect.any(String),
          ORCA_WORKTREE_ID: result.worktree.id
        }),
        worktreeId: result.worktree.id
      })
    )
    const setupSpawnEnv =
      (spawn.mock.calls[1]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expectStablePaneKeyEnv(setupSpawnEnv)
    const setupLeafId = setupSpawnEnv.ORCA_PANE_KEY.slice(`${setupSpawnEnv.ORCA_TAB_ID}:`.length)
    expect(revealTerminalSession).toHaveBeenLastCalledWith(result.worktree.id, {
      ptyId: 'pty-setup',
      title: 'Setup',
      activate: false,
      tabId: setupSpawnEnv.ORCA_TAB_ID,
      leafId: setupLeafId
    })
  })

  it('creates the first terminal for CLI-created worktrees without activating them', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-created-worktree' })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-created-worktree' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-initial-terminal')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-initial-terminal')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-initial-terminal',
        head: 'def',
        branch: 'runtime-initial-terminal',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-initial-terminal'
    })

    expect(activateWorktree).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-initial-terminal',
        worktreeId: result.worktree.id,
        preAllocatedHandle: expect.stringMatching(/^term_/)
      })
    )
    const initialSpawnEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expectStablePaneKeyEnv(initialSpawnEnv)
    const initialLeafId = initialSpawnEnv.ORCA_PANE_KEY.slice(
      `${initialSpawnEnv.ORCA_TAB_ID}:`.length
    )
    expect(revealTerminalSession).toHaveBeenCalledWith(result.worktree.id, {
      ptyId: 'pty-created-worktree',
      title: null,
      activate: false,
      tabId: initialSpawnEnv.ORCA_TAB_ID,
      leafId: initialLeafId
    })
  })

  it('keeps CLI-created worktrees successful when initial terminal creation fails', async () => {
    const runtime = new OrcaRuntimeService(store)
    const spawn = vi.fn().mockRejectedValue(new Error('pty unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-terminal-fail')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-terminal-fail')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-terminal-fail',
        head: 'def',
        branch: 'runtime-terminal-fail',
        isBare: false,
        isMainWorktree: false
      }
    ])

    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'runtime-terminal-fail'
        })
      ).resolves.toMatchObject({
        worktree: expect.objectContaining({
          path: '/tmp/workspaces/runtime-terminal-fail'
        }),
        warning:
          'Failed to create the initial terminal for /tmp/workspaces/runtime-terminal-fail: pty unavailable'
      })
      expect(spawn).toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        '[worktree-create] Failed to create the initial terminal for /tmp/workspaces/runtime-terminal-fail: pty unavailable'
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('activates CLI-created worktrees only when explicitly requested', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-activate')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-activate')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/runtime-activate',
        head: 'def',
        branch: 'runtime-activate',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-activate',
      activate: true
    })

    expect(activateWorktree).toHaveBeenCalledWith('repo-1', expect.any(String), undefined)
  })

  it('stamps createdAt alongside lastActivityAt so CLI-created worktrees get the Recent-sort grace window', async () => {
    // Why: parity with createLocalWorktree / createRemoteWorktree. Without
    // createdAt, ambient PTY bumps in OTHER worktrees during the few seconds
    // after creation can push the new worktree below them in Recent sort.
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-grace')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-grace')
    vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: {} })
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/runtime-grace',
        head: 'def',
        branch: 'runtime-grace',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const before = Date.now()
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-grace'
    })
    const after = Date.now()

    expect(result.worktree.createdAt).toBeDefined()
    expect(result.worktree.createdAt).toBeGreaterThanOrEqual(before)
    expect(result.worktree.createdAt).toBeLessThanOrEqual(after)
    // Both fields must be stamped from the same `now` so the grace-window
    // math (max(lastActivityAt, createdAt + GRACE_MS)) is well-defined.
    expect(result.worktree.createdAt).toBe(result.worktree.lastActivityAt)
  })

  it('skips archive hooks for CLI worktree removal by default', async () => {
    const runtime = new OrcaRuntimeService(store)
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        archive: 'pnpm worktree:archive'
      }
    })
    vi.mocked(removeWorktree).mockResolvedValue(undefined)

    const result = await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    expect(runHook).not.toHaveBeenCalled()
    expect(removeWorktree).toHaveBeenCalledWith(TEST_REPO_PATH, TEST_WORKTREE_PATH, false)
    expect(result.warning).toBe(
      `orca.yaml archive hook skipped for ${TEST_WORKTREE_PATH}; pass --run-hooks to run it.`
    )
  })

  it('runs archive hooks for CLI worktree removal when hooks are explicitly enabled', async () => {
    const runtime = new OrcaRuntimeService(store)
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        archive: 'pnpm worktree:archive'
      }
    })
    vi.mocked(runHook).mockResolvedValue({ success: true, output: '' })
    vi.mocked(removeWorktree).mockResolvedValue(undefined)

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID, false, true)

    expect(runHook).toHaveBeenCalledWith(
      'archive',
      TEST_WORKTREE_PATH,
      expect.objectContaining({ id: TEST_REPO_ID, path: TEST_REPO_PATH })
    )
    expect(removeWorktree).toHaveBeenCalledWith(TEST_REPO_PATH, TEST_WORKTREE_PATH, false)
  })

  it('clears optimistic reconcile tokens when a CLI worktree removal succeeds', async () => {
    const runtime = new OrcaRuntimeService(store)
    const worktreeBaseStatus = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      worktreeBaseStatus,
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    vi.mocked(removeWorktree).mockResolvedValue(undefined)

    const token = runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)
    await runtime.reconcileWorktreeBaseStatus({
      repoId: TEST_REPO_ID,
      repoPath: TEST_REPO_PATH,
      worktreeId: TEST_WORKTREE_ID,
      base: {
        remote: 'origin',
        branch: 'main',
        ref: 'refs/remotes/origin/main',
        base: 'origin/main'
      },
      branchName: 'feature',
      createdBaseSha: 'created-sha',
      token,
      fetchPromise: Promise.resolve({ ok: true })
    })

    expect(worktreeBaseStatus).not.toHaveBeenCalled()
  })

  it('invalidates the filesystem-auth cache after CLI worktree creation', async () => {
    // Reproduces: CLI-created worktrees fail with "Access denied: unknown
    // repository or worktree path" because the filesystem-auth cache was
    // not invalidated, so git:branchCompare could not resolve the new path.
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/cli-worktree')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/cli-worktree')
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/cli-worktree',
        head: 'abc',
        branch: 'cli-worktree',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'cli-worktree'
    })

    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
  })

  it('preserves create-time metadata on later runtime listings when Windows path formatting differs', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      getRepo: (id: string) => runtimeStore.getRepos().find((repo) => repo.id === id),
      getRepos: () => [
        {
          id: 'repo-1',
          path: 'C:\\repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1
        }
      ],
      addRepo: () => {},
      updateRepo: () => undefined as never,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existingMeta = metaById[worktreeId]
        const nextMeta: WorktreeMeta = {
          displayName: meta.displayName ?? existingMeta?.displayName ?? '',
          comment: meta.comment ?? existingMeta?.comment ?? '',
          linkedIssue: meta.linkedIssue ?? existingMeta?.linkedIssue ?? null,
          linkedPR: meta.linkedPR ?? existingMeta?.linkedPR ?? null,
          linkedLinearIssue: meta.linkedLinearIssue ?? existingMeta?.linkedLinearIssue ?? null,
          linkedGitLabMR: meta.linkedGitLabMR ?? existingMeta?.linkedGitLabMR ?? null,
          linkedGitLabIssue: meta.linkedGitLabIssue ?? existingMeta?.linkedGitLabIssue ?? null,
          isArchived: meta.isArchived ?? existingMeta?.isArchived ?? false,
          isUnread: meta.isUnread ?? existingMeta?.isUnread ?? false,
          isPinned: meta.isPinned ?? existingMeta?.isPinned ?? false,
          sortOrder: meta.sortOrder ?? existingMeta?.sortOrder ?? 0,
          lastActivityAt: meta.lastActivityAt ?? existingMeta?.lastActivityAt ?? 0
        }
        metaById[worktreeId] = nextMeta
        return nextMeta
      },
      removeWorktreeMeta: () => {},
      getGitHubCache: () => undefined as never,
      getSettings: () => ({
        workspaceDir: 'C:\\workspaces',
        nestWorkspaces: false,
        refreshLocalBaseRefOnWorktreeCreate: false,
        branchPrefix: 'none',
        branchPrefixCustom: ''
      })
    }
    computeWorktreePathMock.mockReturnValue('C:\\workspaces\\improve-dashboard')
    ensurePathWithinWorkspaceMock.mockReturnValue('C:\\workspaces\\improve-dashboard')
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: 'C:/workspaces/improve-dashboard',
          head: 'abc',
          branch: 'refs/heads/improve-dashboard',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: 'C:/workspaces/improve-dashboard',
          head: 'abc',
          branch: 'refs/heads/improve-dashboard',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const runtime = new OrcaRuntimeService(runtimeStore)
    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'Improve Dashboard'
    })
    const listed = await runtime.listManagedWorktrees('id:repo-1')

    expect(listed.worktrees).toMatchObject([
      {
        id: 'repo-1::C:/workspaces/improve-dashboard',
        displayName: 'Improve Dashboard'
      }
    ])
  })

  describe('browser page targeting', () => {
    it('passes explicit page ids through without resolving the current worktree', async () => {
      vi.mocked(listWorktrees).mockClear()
      const runtime = createRuntime()
      const snapshotMock = vi.fn().mockResolvedValue({
        browserPageId: 'page-1',
        snapshot: 'tree',
        refs: [],
        url: 'https://example.com',
        title: 'Example'
      })

      runtime.setAgentBrowserBridge({
        snapshot: snapshotMock
      } as never)

      const result = await runtime.browserSnapshot({ page: 'page-1' })

      expect(result.browserPageId).toBe('page-1')
      expect(snapshotMock).toHaveBeenCalledWith(undefined, 'page-1')
      expect(listWorktrees).not.toHaveBeenCalled()
    })

    it('resolves explicit worktree selectors when page ids are also provided', async () => {
      vi.mocked(listWorktrees).mockClear()
      const runtime = createRuntime()
      const snapshotMock = vi.fn().mockResolvedValue({
        browserPageId: 'page-1',
        snapshot: 'tree',
        refs: [],
        url: 'https://example.com',
        title: 'Example'
      })

      runtime.setAgentBrowserBridge({
        snapshot: snapshotMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]]))
      } as never)

      await runtime.browserSnapshot({
        worktree: 'branch:feature/foo',
        page: 'page-1'
      })

      expect(snapshotMock).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'page-1')
    })

    it('routes tab switch and capture start by explicit page id', async () => {
      const runtime = createRuntime()
      const tabSwitchMock = vi.fn().mockResolvedValue({
        switched: 2,
        browserPageId: 'page-2'
      })
      const captureStartMock = vi.fn().mockResolvedValue({
        capturing: true
      })

      runtime.setAgentBrowserBridge({
        tabSwitch: tabSwitchMock,
        captureStart: captureStartMock
      } as never)

      await expect(runtime.browserTabSwitch({ page: 'page-2' })).resolves.toEqual({
        switched: 2,
        browserPageId: 'page-2'
      })
      await expect(runtime.browserCaptureStart({ page: 'page-2' })).resolves.toEqual({
        capturing: true
      })
      expect(tabSwitchMock).toHaveBeenCalledWith(undefined, undefined, 'page-2')
      expect(captureStartMock).toHaveBeenCalledWith(undefined, 'page-2')
    })

    it('accepts focus on tab switch without altering bridge args (focus is main-side concern)', async () => {
      const runtime = createRuntime()
      const tabSwitchMock = vi.fn().mockResolvedValue({
        switched: 0,
        browserPageId: 'page-1'
      })

      runtime.setAgentBrowserBridge({ tabSwitch: tabSwitchMock } as never)

      await expect(runtime.browserTabSwitch({ page: 'page-1', focus: true })).resolves.toEqual({
        switched: 0,
        browserPageId: 'page-1'
      })
      // Bridge is unchanged — focus is delivered to the renderer via IPC
      // (notifyRendererBrowserPaneFocus), not threaded through bridge state.
      expect(tabSwitchMock).toHaveBeenCalledWith(undefined, undefined, 'page-1')
    })

    it('does not silently drop invalid explicit worktree selectors for page-targeted commands', async () => {
      vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
      const runtime = createRuntime()
      const snapshotMock = vi.fn()

      runtime.setAgentBrowserBridge({
        snapshot: snapshotMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]]))
      } as never)

      await expect(
        runtime.browserSnapshot({
          worktree: 'path:/tmp/missing-worktree',
          page: 'page-1'
        })
      ).rejects.toThrow('selector_not_found')
      expect(snapshotMock).not.toHaveBeenCalled()
    })

    it('does not silently drop invalid explicit worktree selectors for non-page browser commands', async () => {
      vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
      const runtime = createRuntime()
      const tabListMock = vi.fn()

      runtime.setAgentBrowserBridge({
        tabList: tabListMock
      } as never)

      await expect(
        runtime.browserTabList({
          worktree: 'path:/tmp/missing-worktree'
        })
      ).rejects.toThrow('selector_not_found')
      expect(tabListMock).not.toHaveBeenCalled()
    })

    it('rejects closing an unknown page id instead of treating it as success', async () => {
      vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
      const runtime = createRuntime()

      runtime.setAgentBrowserBridge({
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]]))
      } as never)

      await expect(
        runtime.browserTabClose({
          page: 'missing-page'
        })
      ).rejects.toThrow('Browser page missing-page was not found')
    })

    it('rejects closing a page outside the explicitly scoped worktree', async () => {
      vi.mocked(listWorktrees).mockResolvedValue([
        ...MOCK_GIT_WORKTREES,
        {
          path: '/tmp/worktree-b',
          head: 'def',
          branch: 'feature/bar',
          isBare: false,
          isMainWorktree: false
        }
      ])
      const runtime = createRuntime()
      const getRegisteredTabsMock = vi.fn((worktreeId?: string) =>
        worktreeId === `${TEST_REPO_ID}::/tmp/worktree-b` ? new Map() : new Map([['page-1', 1]])
      )

      runtime.setAgentBrowserBridge({
        getRegisteredTabs: getRegisteredTabsMock
      } as never)

      await expect(
        runtime.browserTabClose({
          page: 'page-1',
          worktree: 'path:/tmp/worktree-b'
        })
      ).rejects.toThrow('Browser page page-1 was not found in this worktree')
      expect(getRegisteredTabsMock).toHaveBeenCalledWith(`${TEST_REPO_ID}::/tmp/worktree-b`)
    })
  })

  describe('removeManagedWorktree PTY teardown (design §4.3)', () => {
    function createProviderStub(
      listProcesses: () => Promise<{ id: string; cwd: string; title: string }[]>
    ): {
      spawn: ReturnType<typeof vi.fn>
      attach: ReturnType<typeof vi.fn>
      write: ReturnType<typeof vi.fn>
      resize: ReturnType<typeof vi.fn>
      shutdown: ReturnType<typeof vi.fn>
      sendSignal: ReturnType<typeof vi.fn>
      getCwd: ReturnType<typeof vi.fn>
      getInitialCwd: ReturnType<typeof vi.fn>
      clearBuffer: ReturnType<typeof vi.fn>
      acknowledgeDataEvent: ReturnType<typeof vi.fn>
      hasChildProcesses: ReturnType<typeof vi.fn>
      getForegroundProcess: ReturnType<typeof vi.fn>
      serialize: ReturnType<typeof vi.fn>
      revive: ReturnType<typeof vi.fn>
      listProcesses: ReturnType<typeof vi.fn>
      getDefaultShell: ReturnType<typeof vi.fn>
      getProfiles: ReturnType<typeof vi.fn>
      onData: ReturnType<typeof vi.fn>
      onReplay: ReturnType<typeof vi.fn>
      onExit: ReturnType<typeof vi.fn>
    } {
      return {
        spawn: vi.fn(),
        attach: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
        sendSignal: vi.fn(),
        getCwd: vi.fn(),
        getInitialCwd: vi.fn(),
        clearBuffer: vi.fn(),
        acknowledgeDataEvent: vi.fn(),
        hasChildProcesses: vi.fn(),
        getForegroundProcess: vi.fn(),
        serialize: vi.fn(),
        revive: vi.fn(),
        listProcesses: vi.fn(listProcesses),
        getDefaultShell: vi.fn(),
        getProfiles: vi.fn(),
        onData: vi.fn().mockReturnValue(() => {}),
        onReplay: vi.fn().mockReturnValue(() => {}),
        onExit: vi.fn().mockReturnValue(() => {})
      }
    }

    it('RPC-initiated delete kills matching PTYs before git', async () => {
      // Seed the runtime with a live leaf whose worktreeId matches the target.
      const killSpy = vi.fn().mockReturnValue(true)
      const localProvider = createProviderStub(async () => [])
      const callOrder: string[] = []
      vi.mocked(removeWorktree).mockImplementation(async () => {
        callOrder.push('git-removeWorktree')
      })

      const runtime = new OrcaRuntimeService(store, undefined, {
        getLocalProvider: () => {
          callOrder.push('getLocalProvider')
          return localProvider as never
        }
      })
      runtime.setPtyController({
        write: () => true,
        kill: (id) => {
          callOrder.push(`kill:${id}`)
          return killSpy(id) as boolean
        },
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime, 'pty-1')

      await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

      expect(killSpy).toHaveBeenCalledWith('pty-1')
      // The provider-prefix sweep and the git removal must happen AFTER the
      // runtime-graph kill. Git removal must NOT happen before any kill.
      const killIdx = callOrder.indexOf('kill:pty-1')
      const gitIdx = callOrder.indexOf('git-removeWorktree')
      expect(killIdx).toBeGreaterThanOrEqual(0)
      expect(gitIdx).toBeGreaterThan(killIdx)
    })

    it('thunk resolves the installed provider lazily, not at construction time', async () => {
      // Simulates the daemon adapter being installed AFTER OrcaRuntimeService
      // construction (setLocalPtyProvider(routedAdapter) in daemon-init).
      // A capture-at-construction refactor would break this test.
      const preDaemonProvider = createProviderStub(async () => [
        { id: '1', cwd: '/tmp', title: 'shell' },
        { id: '2', cwd: '/tmp', title: 'shell' }
      ])
      const postDaemonProvider = createProviderStub(async () => [
        { id: `${TEST_WORKTREE_ID}@@aaaaaaaa`, cwd: '/tmp', title: 'shell' }
      ])
      let currentProvider: ReturnType<typeof createProviderStub> = preDaemonProvider

      const runtime = new OrcaRuntimeService(store, undefined, {
        getLocalProvider: () => currentProvider as never
      })
      vi.mocked(removeWorktree).mockResolvedValue(undefined)

      // Simulate daemon-init swapping the provider after construction.
      currentProvider = postDaemonProvider

      await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

      // The post-daemon provider's prefix-matching session must have been
      // shut down, proving the thunk resolved lazily at call time.
      expect(postDaemonProvider.shutdown).toHaveBeenCalledWith(`${TEST_WORKTREE_ID}@@aaaaaaaa`, {
        immediate: true
      })
      // The pre-daemon provider must not have been consulted for the kill.
      expect(preDaemonProvider.shutdown).not.toHaveBeenCalled()
    })
  })
})
