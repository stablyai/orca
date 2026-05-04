/* eslint-disable max-lines -- Why: this file groups all repos IPC handler
tests (addRemote, getBaseRefDefault envelope, searchBaseRefs SSH relay) so
fixture setup and mock plumbing can be shared. Splitting by line count would
duplicate the hoisted mocks and the `../git/repo` partial-real/partial-stub
setup. */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type * as RepoModule from '../git/repo'

const { handleMock, mockStore, mockGitProvider, mockMultiplexer } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  mockStore: {
    getRepos: vi.fn().mockReturnValue([]),
    addRepo: vi.fn(),
    removeRepo: vi.fn(),
    getRepo: vi.fn(),
    updateRepo: vi.fn(),
    getSshTarget: vi.fn()
  },
  mockGitProvider: {
    isGitRepo: vi.fn().mockReturnValue(true),
    isGitRepoAsync: vi.fn().mockResolvedValue({ isRepo: true, rootPath: null }),
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
  },
  mockMultiplexer: {
    request: vi.fn(),
    notify: vi.fn()
  }
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: handleMock,
    removeHandler: vi.fn()
  }
}))

vi.mock('../git/repo', async () => {
  // Why: pull real implementations of pure helpers so SSH parity tests
  // exercise the actual probe list and query sanitizer, not frozen copies.
  // Drift in DEFAULT_BASE_REF_PROBES or normalizeRefSearchQuery now surfaces
  // as test failure, not silent test-passes against stale behavior.
  const actual = await vi.importActual<typeof RepoModule>('../git/repo')
  return {
    ...actual,
    // Stub only the functions that spawn git / touch the filesystem.
    isGitRepo: vi.fn().mockReturnValue(true),
    getGitUsername: vi.fn().mockReturnValue(''),
    getRepoName: vi.fn().mockImplementation((path: string) => path.split('/').pop()),
    getBaseRefDefault: vi.fn().mockResolvedValue('origin/main'),
    getRemoteCount: vi.fn().mockResolvedValue(1),
    searchBaseRefs: vi.fn().mockResolvedValue([])
  }
})

vi.mock('./filesystem-auth', () => ({
  rebuildAuthorizedRootsCache: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn().mockImplementation((id: string) => {
    if (id === 'conn-1') {
      return mockGitProvider
    }
    return undefined
  })
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: vi.fn().mockImplementation((id: string) => {
    if (id === 'conn-1') {
      return mockMultiplexer
    }
    return undefined
  })
}))

import { registerRepoHandlers } from './repos'

describe('repos:addRemote', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.addRepo.mockReset()
    mockStore.getSshTarget.mockReset()
    mockMultiplexer.request.mockReset()
    mockMultiplexer.notify.mockReset()
    mockWindow.webContents.send.mockReset()

    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('registers the repos:addRemote handler', () => {
    expect(handlers.has('repos:addRemote')).toBe(true)
  })

  it('creates a remote repo with connectionId', async () => {
    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/home/user/project',
        connectionId: 'conn-1',
        kind: 'git',
        displayName: 'project'
      })
    )
    expect(result).toHaveProperty('repo.id')
    expect(result).toHaveProperty('repo.connectionId', 'conn-1')
  })

  it('uses custom displayName when provided', async () => {
    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project',
      displayName: 'My Server Repo'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'My Server Repo',
        path: '/home/user/project'
      })
    )
    expect(result).toHaveProperty('repo.displayName', 'My Server Repo')
  })

  it('returns existing repo if same connectionId and path already added', async () => {
    const existing = {
      id: 'existing-id',
      path: '/home/user/project',
      connectionId: 'conn-1',
      displayName: 'project',
      badgeColor: '#fff',
      addedAt: 1000,
      kind: 'git'
    }
    mockStore.getRepos.mockReturnValue([existing])

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project'
    })

    expect(result).toEqual({ repo: existing })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('throws when SSH connection is not found', async () => {
    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'unknown-conn',
      remotePath: '/home/user/project'
    })
    expect(result).toEqual({ error: 'SSH connection "unknown-conn" not found or not connected' })
  })

  it('throws when remote path is not a git repo', async () => {
    mockGitProvider.isGitRepoAsync.mockResolvedValueOnce({ isRepo: false, rootPath: null })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/documents'
    })
    expect(result).toEqual({ error: 'Not a valid git repository: /home/user/documents' })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('adds as folder when kind is explicitly set', async () => {
    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/documents',
      kind: 'folder'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'folder',
        path: '/home/user/documents'
      })
    )
    expect(result).toHaveProperty('repo.kind', 'folder')
  })

  it('uses rootPath from git detection when available', async () => {
    mockGitProvider.isGitRepoAsync.mockResolvedValueOnce({
      isRepo: true,
      rootPath: '/home/user/project'
    })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project/src'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'git',
        path: '/home/user/project'
      })
    )
    expect(result).toHaveProperty('repo.path', '/home/user/project')
  })

  it('notifies renderer when remote repo is added', async () => {
    await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project'
    })

    expect(mockWindow.webContents.send).toHaveBeenCalledWith('repos:changed')
  })

  it('resolves ~ to absolute path via relay and uses SSH target label', async () => {
    mockMultiplexer.request.mockResolvedValueOnce({ resolvedPath: '/home/ubuntu' })
    mockStore.getSshTarget.mockReturnValueOnce({
      id: 'conn-1',
      label: 'ubuntu-box',
      host: '192.168.1.100',
      port: 22,
      username: 'user'
    })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '~'
    })

    expect(mockMultiplexer.request).toHaveBeenCalledWith('session.resolveHome', { path: '~' })
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'ubuntu-box',
        path: '/home/ubuntu'
      })
    )
    expect(result).toHaveProperty('repo.displayName', 'ubuntu-box')
    expect(result).toHaveProperty('repo.path', '/home/ubuntu')
  })

  it('resolves ~/subdir to absolute path via relay', async () => {
    mockMultiplexer.request.mockResolvedValueOnce({ resolvedPath: '/home/ubuntu/subdir' })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '~/subdir'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/home/ubuntu/subdir',
        displayName: 'subdir'
      })
    )
    expect(result).toHaveProperty('repo.path', '/home/ubuntu/subdir')
  })

  it('ignores SSH target label when custom displayName is provided', async () => {
    mockMultiplexer.request.mockResolvedValueOnce({ resolvedPath: '/home/ubuntu' })
    mockStore.getSshTarget.mockReturnValueOnce({
      id: 'conn-1',
      label: 'ubuntu-box',
      host: '192.168.1.100',
      port: 22,
      username: 'user'
    })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '~',
      displayName: 'My Home'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'My Home',
        path: '/home/ubuntu'
      })
    )
    expect(result).toHaveProperty('repo.displayName', 'My Home')
  })
})

describe('repos:getBaseRefDefault envelope', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.getRepo.mockReset()
    // Reset exec to default: later SSH tests replace this with custom mocks, and
    // without this reset any future test added to this block would inherit the
    // last test's exec mock — latent fragility we guard against here.
    mockGitProvider.exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('returns { defaultBaseRef, remoteCount: 0 } for folder-mode repos', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/some/folder',
      kind: 'folder'
    })

    const result = await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })

    expect(result).toEqual({ defaultBaseRef: null, remoteCount: 0 })
  })

  it('returns { defaultBaseRef: null, remoteCount: 0 } for an unknown repoId', async () => {
    mockStore.getRepo.mockReturnValue(undefined)

    const result = await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'missing' })

    expect(result).toEqual({ defaultBaseRef: null, remoteCount: 0 })
  })

  it('wraps the local getBaseRefDefault result in the envelope', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/repo',
      kind: 'git'
    })

    const result = (await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })) as {
      defaultBaseRef: string | null
      remoteCount: number
    }

    // getBaseRefDefault is mocked to 'origin/main', getRemoteCount to 1
    expect(result.defaultBaseRef).toBe('origin/main')
    expect(result.remoteCount).toBe(1)
  })

  // Why: the SSH handler resolves default-ref and remote-count in parallel
  // (Promise.all) so the order of calls into provider.exec is not stable.
  // Dispatch on argv instead of `mockResolvedValueOnce` chains so tests remain
  // independent of which Promise in the Promise.all resolves first.
  type ExecResponse = { stdout: string; stderr: string }
  type ExecRule = {
    match: (argv: string[]) => boolean
    respond: () => Promise<ExecResponse>
  }
  const dispatchExec = (rules: ExecRule[]): ((argv: string[]) => Promise<ExecResponse>) => {
    return (argv: string[]) => {
      for (const rule of rules) {
        if (rule.match(argv)) {
          return rule.respond()
        }
      }
      return Promise.reject(new Error(`unexpected exec call: ${argv.join(' ')}`))
    }
  }
  const isSymbolicRef = (argv: string[]): boolean =>
    argv[0] === 'symbolic-ref' && argv.includes('refs/remotes/origin/HEAD')
  const isRevParseFor =
    (ref: string) =>
    (argv: string[]): boolean =>
      argv[0] === 'rev-parse' && argv.includes(ref)
  const isRemoteList = (argv: string[]): boolean => argv.length === 1 && argv[0] === 'remote'

  it('returns envelope over SSH relay for remote repos', async () => {
    mockGitProvider.exec = vi.fn().mockImplementation(
      dispatchExec([
        {
          match: isSymbolicRef,
          respond: () => Promise.resolve({ stdout: 'refs/remotes/origin/main\n', stderr: '' })
        },
        {
          match: isRemoteList,
          respond: () => Promise.resolve({ stdout: 'origin\nupstream\n', stderr: '' })
        }
      ])
    )

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = (await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })) as {
      defaultBaseRef: string | null
      remoteCount: number
    }

    expect(result.defaultBaseRef).toBe('origin/main')
    expect(result.remoteCount).toBe(2)
  })

  it('returns defaultBaseRef even when remote-count lookup fails', async () => {
    mockGitProvider.exec = vi.fn().mockImplementation(
      dispatchExec([
        {
          match: isSymbolicRef,
          respond: () => Promise.resolve({ stdout: 'refs/remotes/origin/main\n', stderr: '' })
        },
        {
          match: isRemoteList,
          respond: () => Promise.reject(new Error('relay exec failed'))
        }
      ])
    )

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = (await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })) as {
      defaultBaseRef: string | null
      remoteCount: number
    }

    // Why: default detection must be independent of remote-count lookup.
    // A failing count falls back to 0, but the default still resolves.
    expect(result.defaultBaseRef).toBe('origin/main')
    expect(result.remoteCount).toBe(0)
  })

  it('falls back through probes over SSH when symbolic-ref fails', async () => {
    mockGitProvider.exec = vi.fn().mockImplementation(
      dispatchExec([
        // symbolic-ref rejects (no origin/HEAD on the remote)
        { match: isSymbolicRef, respond: () => Promise.reject(new Error('no symbolic-ref')) },
        // probe 1: refs/remotes/origin/main — rejects
        {
          match: isRevParseFor('refs/remotes/origin/main'),
          respond: () => Promise.reject(new Error('missing'))
        },
        // probe 2: refs/remotes/origin/master — succeeds
        {
          match: isRevParseFor('refs/remotes/origin/master'),
          respond: () => Promise.resolve({ stdout: 'abc123\n', stderr: '' })
        },
        { match: isRemoteList, respond: () => Promise.resolve({ stdout: 'origin\n', stderr: '' }) }
      ])
    )

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = (await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })) as {
      defaultBaseRef: string | null
      remoteCount: number
    }

    // Why: when symbolic-ref fails, the probe chain should find
    // refs/remotes/origin/master and return 'origin/master', matching
    // the local path's getDefaultBaseRefAsync behavior.
    expect(result.defaultBaseRef).toBe('origin/master')
    expect(result.remoteCount).toBe(1)
  })
})

describe('repos:searchBaseRefs SSH relay', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.getRepo.mockReset()
    mockGitProvider.exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('returns [] for a folder-mode repo without invoking the relay', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/some/folder',
      kind: 'folder',
      connectionId: 'conn-1'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: 'main'
    })

    expect(result).toEqual([])
    expect(mockGitProvider.exec).not.toHaveBeenCalled()
  })

  it('short-circuits an empty query without calling the relay', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: ''
    })

    // Why: empty-query short-circuit must happen in the handler (mirrors the
    // local path's normalizeRefSearchQuery guard). Without it a user-typed
    // empty query would leak every ref from the remote.
    expect(result).toEqual([])
    expect(mockGitProvider.exec).not.toHaveBeenCalled()
  })

  it('short-circuits a query containing only glob metacharacters', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: '***'
    })

    // Why: normalizeRefSearchQuery strips `*?[]\`, so a query made up only of
    // glob metacharacters normalizes to '' and must be treated like an empty
    // query (no relay call, no leaked refs). Guards against glob injection
    // via the SSH branch.
    expect(result).toEqual([])
    expect(mockGitProvider.exec).not.toHaveBeenCalled()
  })

  it('sends the widened argv (refs/remotes/*/*) so upstream branches are discoverable', async () => {
    // Why: this is the core issue-624 behavior — the SSH path must glob all
    // remotes, not just origin. If this ever regresses to refs/remotes/origin/*,
    // SSH fork users go back to being structurally blocked.
    mockGitProvider.exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    await handlers.get('repos:searchBaseRefs')!(null, { repoId: 'r1', query: 'upstream' })

    expect(mockGitProvider.exec).toHaveBeenCalledTimes(1)
    const [argv, path] = mockGitProvider.exec.mock.calls[0]
    expect(path).toBe('/remote/repo')
    expect(argv[0]).toBe('for-each-ref')
    expect(argv).toContain('refs/remotes/*upstream*/*')
    expect(argv).toContain('refs/remotes/*/*upstream*')
    expect(argv).toContain('refs/heads/*upstream*')
    // Guard against regression to the old origin-only glob.
    expect(argv).not.toContain('refs/remotes/origin/*upstream*')
  })

  it('sends segmented argv for display-format queries like `upstream/main`', async () => {
    // Why: guards against the SSH path drifting from the local path for
    // multi-segment queries. The picker shows results as `<remote>/<branch>`
    // and users retype that format; if the SSH argv reverts to a single
    // `*<q>*` glob containing the literal `/`, SSH users silently see no
    // matches for valid refs — the same shape of bug as issue #624.
    mockGitProvider.exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    await handlers.get('repos:searchBaseRefs')!(null, { repoId: 'r1', query: 'upstream/main' })

    expect(mockGitProvider.exec).toHaveBeenCalledTimes(1)
    const [argv] = mockGitProvider.exec.mock.calls[0]
    expect(argv).toContain('refs/remotes/*upstream*/*main*')
    expect(argv).toContain('refs/heads/*upstream*/*main*')
    // Regression guard: the literal slash must never appear inside a
    // single segmented glob (would be `refs/remotes/*upstream/main*`),
    // which fnmatch cannot match because `*` doesn't cross `/`.
    expect(argv).not.toContain('refs/remotes/*upstream/main*/*')
    expect(argv).not.toContain('refs/remotes/*/*upstream/main*')
  })

  it('parses NUL-delimited stdout and filters <remote>/HEAD pseudo-refs', async () => {
    // Why: exercises the shared parseAndFilterSearchRefs pipeline end-to-end
    // on the SSH path — confirms the HEAD filter works for any remote (not
    // just origin) when results come from the relay.
    const stdout = [
      'refs/remotes/origin/main\0origin/main',
      'refs/remotes/upstream/main\0upstream/main',
      'refs/remotes/upstream/HEAD\0upstream/HEAD',
      'refs/remotes/origin/HEAD\0origin/HEAD'
    ].join('\n')
    mockGitProvider.exec = vi.fn().mockResolvedValue({ stdout, stderr: '' })

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = (await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: 'main'
    })) as string[]

    expect(result).toEqual(['origin/main', 'upstream/main'])
    expect(result).not.toContain('origin/HEAD')
    expect(result).not.toContain('upstream/HEAD')
  })

  it('returns [] when the relay exec throws', async () => {
    mockGitProvider.exec = vi.fn().mockRejectedValue(new Error('ssh connection dropped'))

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: 'main'
    })

    // Why: transport failure must fall back to an empty result set — mirrors
    // the local path's catch, so SSH users see "no matches" instead of a
    // crashed picker when the relay drops.
    expect(result).toEqual([])
  })

  it('returns [] when the SSH provider is not connected', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'unknown-conn',
      kind: 'git'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: 'main'
    })

    expect(result).toEqual([])
  })
})
