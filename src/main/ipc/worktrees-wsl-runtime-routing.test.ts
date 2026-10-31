import type * as NodeFs from 'node:fs/promises'
import { REVIEW_HEAD_FETCH_TIMEOUT_MS } from '../../shared/review-head-tracking-ref'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  setPlatform,
  listWorktreesMock,
  assertWorktreeCleanForRemovalMock,
  addWorktreeMock,
  removeWorktreeMock,
  resolveDefaultBaseRefWithLocalGitMock,
  getDefaultRemoteMock,
  getBranchConflictKindMock,
  getPRForBranchMock,
  getEffectiveHooksMock,
  createSetupRunnerScriptMock,
  getEffectiveHooksFromConfigMock,
  shouldRunSetupForCreateMock,
  getBaseRefDefaultMock,
  gitExecFileAsyncMock
} from './worktrees-test-module-mocks'
import { handlers, harnessRepo, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { materializeWorktreePushTargetRemote } from './worktree-remote'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'
import {
  createdWorktreeList,
  mockKnownFeatureWorktree,
  mockSelectedWslProjectRuntime
} from './worktrees-test-fixtures'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

// Only these routing rows own this virtual host filesystem; other fixtures use the real reader.
const owningLayout = vi.hoisted(() => ({ enabled: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const normalize = (value: unknown) =>
    String(value)
      .replaceAll('\\', '/')
      .replace(/^\/\/wsl\.(?:localhost|\$)\/Ubuntu/i, '')
      .replaceAll('//', '/')
  const missing = () => Object.assign(new Error('Fixture entry is absent'), { code: 'ENOENT' })
  const files = new Map([
    ['/workspace/repo/.git/HEAD', 'ref: refs/heads/main\n'],
    ['/workspace/fix-title/.git', 'gitdir: /workspace/repo/.git/worktrees/fix-title\n'],
    ['/workspace/repo/.git/worktrees/fix-title/HEAD', 'ref: refs/heads/feature/fix\n'],
    ['/workspace/repo/.git/worktrees/fix-title/gitdir', '/workspace/fix-title/.git\n'],
    ['/workspace/repo/.git/worktrees/fix-title/commondir', '../..\n']
  ])
  const directories = new Set([
    '/workspace/repo',
    '/workspace/repo/.git',
    '/workspace/fix-title',
    '/workspace/repo/.git/worktrees',
    '/workspace/repo/.git/worktrees/fix-title'
  ])
  const layoutStat = (method: typeof actual.stat | typeof actual.lstat) =>
    new Proxy(method, {
      apply(fn: (...args: any[]) => ReturnType<typeof method>, receiver, args) {
        const file = normalize(args[0])
        if (!owningLayout.enabled || !file.startsWith('/workspace/')) {
          return fn.apply(receiver, args)
        }
        if (!directories.has(file) && !files.has(file)) {
          return Promise.reject(missing())
        }
        return Promise.resolve({
          isDirectory: () => directories.has(file),
          isFile: () => files.has(file),
          isSymbolicLink: () => false
        })
      }
    })
  return {
    ...actual,
    stat: layoutStat(actual.stat),
    lstat: layoutStat(actual.lstat),
    readFile: new Proxy(actual.readFile, {
      apply(fn: (...args: any[]) => ReturnType<typeof actual.readFile>, receiver, args) {
        const file = normalize(args[0])
        if (!owningLayout.enabled || !file.startsWith('/workspace/')) {
          return fn.apply(receiver, args)
        }
        return files.has(file) ? Promise.resolve(files.get(file)) : Promise.reject(missing())
      }
    }),
    realpath: new Proxy(actual.realpath, {
      apply(fn: (...args: any[]) => ReturnType<typeof actual.realpath>, receiver, args) {
        const file = normalize(args[0])
        if (!owningLayout.enabled || !file.startsWith('/workspace/')) {
          return fn.apply(receiver, args)
        }
        return directories.has(file) || files.has(file)
          ? Promise.resolve(file)
          : Promise.reject(missing())
      }
    }),
    readdir: new Proxy(actual.readdir, {
      apply(fn: (...args: any[]) => ReturnType<typeof actual.readdir>, receiver, args) {
        const file = normalize(args[0])
        if (!owningLayout.enabled || !file.startsWith('/workspace/')) {
          return fn.apply(receiver, args)
        }
        return file === '/workspace/repo/.git/worktrees'
          ? Promise.resolve([
              { name: 'fix-title', isDirectory: () => true, isSymbolicLink: () => false }
            ])
          : Promise.reject(missing())
      }
    })
  }
})

function installOwningGitRoutingFixture(existing = false): void {
  owningLayout.enabled = true
  const oid = 'a'.repeat(40),
    name = existing ? 'origin' : 'pr-contributor-orca'
  const branch = existing ? 'feature/fix' : 'contributor/wsl-fork'
  const destination = `refs/remotes/${name}/${branch}`
  const url = 'git@github.com:contributor/orca.git'
  let added = existing,
    fetched = existing,
    related = false
  gitExecFileAsyncMock.mockImplementation(async (args: string[], options?: { cwd?: string }) => {
    let stdout = ''
    if (args.includes('--git-common-dir')) {
      stdout = '/workspace/repo/.git\n'
    } else if (args[0] === 'rev-parse' && args.includes('--git-path')) {
      stdout = '.git/remotes\n.git/branches\n'
    } else if (args.includes('config') && args.includes('--list')) {
      const values = added
        ? [
            [`remote.${name}.url`, url],
            [`remote.${name}.fetch`, `+refs/heads/${branch}*:refs/remotes/${name}/${branch}*`],
            ...(existing
              ? []
              : [
                  [`remote.${name}.tagopt`, '--no-tags'],
                  [`remote.${name}.orca-created`, 'true']
                ])
          ]
        : []
      stdout = values
        .map(
          ([key, value]) =>
            `${args.includes('--show-origin') ? 'file:/workspace/repo/.git/config\0' : ''}${key}\n${value}\0`
        )
        .join('')
    } else if (args[0] === 'remote' && args[1] === 'add') {
      added = true
    } else if (args.includes('-v')) {
      stdout = ['orca-fork-url-probe', ...(added ? [name] : [])]
        .flatMap((remote) => [`${remote}\t${url} (fetch)`, `${remote}\t${url} (push)`])
        .join('\n')
    } else if (args[0] === 'fetch') {
      fetched = true
    } else if (args[0] === 'branch' && args[1] === '--set-upstream-to') {
      related = true
    } else if (args[0] === 'config' && args.includes('--get')) {
      stdout = 'true\n'
    } else if (args[0] === 'for-each-ref') {
      if (args[1].includes('%(upstream)') && !args[1].includes('%(objectname)')) {
        stdout = `${args.at(-1)}\t${destination}\t${name}\trefs/heads/${branch}\n`
      } else {
        const native = args[1].includes('%(upstream)')
        const refs =
          args.length > 2
            ? args.slice(2)
            : ['refs/heads/main', 'refs/heads/feature/fix', ...(fetched ? [destination] : [])]
        stdout = refs
          .map(
            (ref) =>
              `${ref}\t${oid}\t${native ? `\t${related ? destination : ''}\t${related ? name : ''}\t${related ? `refs/heads/${branch}` : ''}\t${ref === (options?.cwd === '/workspace/fix-title' ? 'refs/heads/feature/fix' : 'refs/heads/main') ? '*' : ''}` : ''}\n`
          )
          .join('')
      }
    }
    return { stdout, stderr: '' }
  })
}

// The WSL distros these fixtures route through count as running, so the boot gate lets Git run.
const runningStateMock = vi.hoisted(() =>
  vi.fn(async (_distro: string, _options?: unknown) => 'running')
)
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: runningStateMock
}))
vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty/provider/registry', async () =>
  (await import('./worktrees-test-module-mocks')).ptyRegistryModuleMock()
)
vi.mock('./pty/provider/state-cleanup', async () =>
  (await import('./worktrees-test-module-mocks')).ptyStateCleanupModuleMock()
)

/** Check all create/prefetch probes against the distro ref store, including shared base-ref resolution. */
function expectEveryGitCallRoutedTo(wslDistro: string): void {
  const callDistros = new Set(
    gitExecFileAsyncMock.mock.calls.map(
      ([, options]) => (options as { wslDistro?: string } | undefined)?.wslDistro
    )
  )
  expect(callDistros).toEqual(new Set([wslDistro]))
}

describe('registerWorktreeHandlers', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    owningLayout.enabled = false
    runtimeStub = setupWorktreeHandlers()
    runningStateMock.mockReset().mockResolvedValue('running')
  })

  // G6: opening the composer prefetches speculatively; that must not boot a stopped distro.
  it('skips the speculative create-base prefetch while the WSL project distro is stopped', async () => {
    mockSelectedWslProjectRuntime()
    runningStateMock.mockResolvedValue('stopped')

    await handlers['worktrees:prefetchCreateBase'](null, { repoId: 'repo-1' })

    expect(runningStateMock).toHaveBeenCalledWith('Ubuntu', expect.anything())
    expect(getBaseRefDefaultMock).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(runtimeStub.resolveRemoteTrackingBase).not.toHaveBeenCalled()
    expect(runtimeStub.fetchRemoteWithCache).not.toHaveBeenCalled()
  })

  it('routes the speculative create-base prefetch through the selected WSL project runtime', async () => {
    mockSelectedWslProjectRuntime()
    const remoteTrackingBase = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(remoteTrackingBase)

    await handlers['worktrees:prefetchCreateBase'](null, { repoId: 'repo-1' })

    expect(getBaseRefDefaultMock).toHaveBeenCalledWith('/workspace/repo', { wslDistro: 'Ubuntu' })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
      { cwd: '/workspace/repo', wslDistro: 'Ubuntu' }
    )
    expect(runtimeStub.resolveRemoteTrackingBase).toHaveBeenCalledWith(
      '/workspace/repo',
      'origin/main',
      { wslDistro: 'Ubuntu' }
    )
    expect(runtimeStub.getOrStartRemoteTrackingBaseRefresh).toHaveBeenCalledWith(
      '/workspace/repo',
      remoteTrackingBase,
      { wslDistro: 'Ubuntu' }
    )
  })

  it('routes the prefetch remote-fetch fallback through the selected WSL project runtime', async () => {
    mockSelectedWslProjectRuntime()
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(null)

    await handlers['worktrees:prefetchCreateBase'](null, {
      repoId: 'repo-1',
      baseBranch: 'feature/topic'
    })

    expect(runtimeStub.fetchRemoteWithCache).toHaveBeenCalledWith('/workspace/repo', 'origin', {
      wslDistro: 'Ubuntu'
    })
  })

  it('routes local worktree creation through the selected WSL project runtime', async () => {
    mockSelectedWslProjectRuntime()
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/repo',
        head: 'base',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'refs/heads/improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard',
      'improve-dashboard',
      'origin/main',
      false,
      false,
      { wslDistro: 'Ubuntu' }
    )
    expect(resolveDefaultBaseRefWithLocalGitMock).toHaveBeenCalledWith({
      cwd: '/workspace/repo',
      wslDistro: 'Ubuntu'
    })
    expect(getBranchConflictKindMock).toHaveBeenCalledWith(
      '/workspace/repo',
      'improve-dashboard',
      'origin/main',
      { wslDistro: 'Ubuntu' }
    )
    expect(listWorktreesMock).toHaveBeenCalledWith(
      '/workspace/repo',
      expect.objectContaining({ wslDistro: 'Ubuntu' })
    )
    expectEveryGitCallRoutedTo('Ubuntu')
  })

  it('routes local worktree creation with a remote tracking base through the selected WSL project runtime', async () => {
    mockSelectedWslProjectRuntime()
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue({
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    })
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'abc123\n', stderr: '' })
    store.getRepo.mockReturnValue({ ...harnessRepo, worktreeBaseRef: 'custom-base' })
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'refs/heads/improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expectEveryGitCallRoutedTo('Ubuntu')
  })

  it('does not mint a fork remote at create time for a WSL-routed worktree', async () => {
    mockSelectedWslProjectRuntime()
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/wsl-fork',
        head: 'abc123',
        branch: 'refs/heads/wsl-fork',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.setWorktreeMeta.mockImplementation((_target: HostWorktreeTarget, meta) => meta)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'wsl-fork',
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'contributor/wsl-fork',
        remoteUrl: 'git@github.com:contributor/orca.git'
      }
    })

    const calls = gitExecFileAsyncMock.mock.calls.map((call) => call[0] as string[])
    expect(calls).not.toContainEqual(['check-ref-format', '--branch', 'contributor/wsl-fork'])
    expect(calls.some((args) => args[0] === 'remote' && args[1] === 'add')).toBe(false)
    expect(calls.some((args) => args[0] === 'fetch')).toBe(false)
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({
        pushTarget: {
          remoteName: 'pr-contributor-orca',
          branchName: 'contributor/wsl-fork',
          remoteUrl: 'git@github.com:contributor/orca.git'
        }
      })
    )
  })

  // Call the same materializer as push/pull to test first-sync routing without registering those handlers.
  it('routes fork push target materialization through the selected WSL project runtime', async () => {
    installOwningGitRoutingFixture()
    const target = {
      remoteName: 'pr-contributor-orca',
      branchName: 'contributor/wsl-fork',
      remoteUrl: 'git@github.com:contributor/orca.git'
    }

    const result = await materializeWorktreePushTargetRemote(
      '/workspace/repo',
      target,
      undefined,
      undefined,
      { wslDistro: 'Ubuntu' }
    )

    expect(result).toEqual({ ...target, remoteCreated: true })
    const wslRoutingOptions = { cwd: '/workspace/repo', wslDistro: 'Ubuntu' }
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['check-ref-format', '--branch', 'contributor/wsl-fork'],
      wslRoutingOptions
    )
    // Bounded creation and exact sync use the selected distro.
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'remote',
        'add',
        '-t',
        'contributor/wsl-fork*',
        '--no-tags',
        'pr-contributor-orca',
        'git@github.com:contributor/orca.git'
      ],
      wslRoutingOptions
    )
    expect(gitExecFileAsyncMock.mock.calls.some(([args]) => args.includes('--replace-all'))).toBe(
      false
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['config', '--local', 'remote.pr-contributor-orca.orca-created', 'true'],
      wslRoutingOptions
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'fetch',
        '--no-tags',
        '--refmap=+refs/heads/contributor/wsl-fork:refs/remotes/pr-contributor-orca/contributor/wsl-fork',
        'pr-contributor-orca',
        '+refs/heads/contributor/wsl-fork:refs/remotes/pr-contributor-orca/contributor/wsl-fork'
      ],
      { ...wslRoutingOptions, timeout: expect.any(Number) }
    )
    const distros = new Set(
      gitExecFileAsyncMock.mock.calls.map(
        ([, options]) => (options as { wslDistro?: string } | undefined)?.wslDistro
      )
    )
    expect(distros).toEqual(new Set(['Ubuntu']))
  })

  it('routes selected PR branch conflict lookup through the selected WSL project runtime', async () => {
    mockSelectedWslProjectRuntime()
    installOwningGitRoutingFixture(true)
    getBranchConflictKindMock.mockResolvedValueOnce('remote')
    getPRForBranchMock.mockResolvedValueOnce({
      number: 42,
      title: 'Selected PR',
      state: 'open',
      url: 'https://example.com/pr/42',
      checksStatus: 'success',
      updatedAt: '2026-06-16T00:00:00.000Z',
      mergeable: 'UNKNOWN'
    })
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/fix-title',
        head: 'abc123',
        branch: 'refs/heads/feature/fix',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix-title',
      baseBranch: 'abc123',
      branchNameOverride: 'feature/fix',
      linkedPR: 42,
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })

    expect(getPRForBranchMock).toHaveBeenCalledWith(
      '/workspace/repo',
      'feature/fix',
      null,
      null,
      null,
      { localGitExecOptions: { wslDistro: 'Ubuntu' } }
    )
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/fix-title',
      'feature/fix',
      'abc123',
      false,
      false,
      { wslDistro: 'Ubuntu' }
    )
  })

  it('routes PR base git calls through the selected WSL project runtime', async () => {
    setPlatform('win32')
    store.getProjects.mockReturnValue([
      {
        id: 'project-1',
        displayName: 'repo',
        badgeColor: '#000',
        sourceRepoIds: ['repo-1'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        createdAt: 0,
        updatedAt: 0
      }
    ])
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'def456\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await handlers['worktrees:resolvePrBase'](null, {
      repoId: 'repo-1',
      prNumber: 42,
      headRefName: 'feature/add-feature',
      isCrossRepository: false
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'fetch',
        'origin',
        '+refs/heads/feature/add-feature:refs/remotes/origin/feature/add-feature'
      ],
      { cwd: '/workspace/repo', wslDistro: 'Ubuntu', timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--verify', 'origin/feature/add-feature'],
      { cwd: '/workspace/repo', wslDistro: 'Ubuntu' }
    )
    expect(getDefaultRemoteMock).toHaveBeenCalledWith(
      '/workspace/repo',
      { wslDistro: 'Ubuntu' },
      []
    )
    expect(result).toMatchObject({
      baseBranch: 'def456',
      headSha: 'def456',
      branchNameOverride: 'feature/add-feature',
      pushTarget: { remoteName: 'origin', branchName: 'feature/add-feature' }
    })
  })

  it('lists detected worktrees through the selected WSL project runtime', async () => {
    setPlatform('win32')
    store.getProjects.mockReturnValue([
      {
        id: 'project-1',
        displayName: 'repo',
        badgeColor: '#000',
        sourceRepoIds: ['repo-1'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        createdAt: 0,
        updatedAt: 0
      }
    ])
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/repo',
        head: 'def456',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])

    const result = await handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })

    expect(listWorktreesMock).toHaveBeenCalledWith('/workspace/repo', { wslDistro: 'Ubuntu' })
    expect(result).toMatchObject({
      repoId: 'repo-1',
      authoritative: true,
      source: 'git',
      worktrees: [expect.objectContaining({ path: '/workspace/repo' })]
    })
  })

  it('routes setup runner generation through the selected WSL project runtime', async () => {
    setPlatform('win32')
    store.getProjects.mockReturnValue([
      {
        id: 'project-1',
        displayName: 'repo',
        badgeColor: '#000',
        sourceRepoIds: ['repo-1'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        createdAt: 0,
        updatedAt: 0
      }
    ])
    listWorktreesMock.mockResolvedValue(createdWorktreeList)
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    getEffectiveHooksFromConfigMock.mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    shouldRunSetupForCreateMock.mockReturnValue(true)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      setupDecision: 'run'
    })

    expect(createSetupRunnerScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      '/workspace/improve-dashboard',
      'pnpm worktree:setup',
      { wslDistro: 'Ubuntu' },
      undefined,
      undefined
    )
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard',
      'improve-dashboard',
      'origin/main',
      false,
      false,
      { wslDistro: 'Ubuntu' }
    )
  })

  it('routes local worktree removal through the selected WSL project runtime', async () => {
    mockSelectedWslProjectRuntime()
    mockKnownFeatureWorktree()
    getEffectiveHooksMock.mockReturnValue(null)
    removeWorktreeMock.mockResolvedValue({})

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(listWorktreesMock).toHaveBeenCalledWith('/workspace/repo', { wslDistro: 'Ubuntu' })
    expect(assertWorktreeCleanForRemovalMock).toHaveBeenCalledWith('/workspace/feature-wt', false, {
      wslDistro: 'Ubuntu'
    })
    expect(removeWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/feature-wt',
      false,
      expect.objectContaining({ wslDistro: 'Ubuntu' })
    )
  })

  it('surfaces selected-runtime list failures during local worktree removal', async () => {
    mockSelectedWslProjectRuntime()
    const listError = new Error('wsl git list failed')
    listWorktreesMock.mockRejectedValue(listError)

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt'
      })
    ).rejects.toThrow('wsl git list failed')

    expect(listWorktreesMock).toHaveBeenCalledWith('/workspace/repo', { wslDistro: 'Ubuntu' })
    expect(assertWorktreeCleanForRemovalMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
  })
})
