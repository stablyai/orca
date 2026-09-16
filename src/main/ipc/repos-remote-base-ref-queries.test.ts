import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../git/runner'
import type * as RepoModule from '../git/repo'

const { reposMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./repos-remote-test-harness')
  return { reposMocks: moduleMocks.createReposIpcMocks(), moduleMocks }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(reposMocks))
vi.mock('../git/repo', async (importOriginal) =>
  moduleMocks.gitRepoModuleMock(await importOriginal<typeof RepoModule>())
)
vi.mock('../git/runner', async (importOriginal) =>
  moduleMocks.gitRunnerModuleMock(reposMocks, await importOriginal<typeof GitRunner>())
)
vi.mock('../git/worktree', () => moduleMocks.gitWorktreeModuleMock(reposMocks))
vi.mock('./registered-worktree-roots-cache', () =>
  moduleMocks.registeredWorktreeRootsCacheModuleMock(reposMocks)
)
vi.mock('../worktree-root-preparation', () =>
  moduleMocks.worktreeRootPreparationModuleMock(reposMocks)
)
vi.mock('../providers/ssh-git-dispatch', () => moduleMocks.sshGitDispatchModuleMock(reposMocks))
vi.mock('../providers/ssh-filesystem-dispatch', () =>
  moduleMocks.sshFilesystemDispatchModuleMock(reposMocks)
)
vi.mock('./ssh', () => moduleMocks.sshModuleMock(reposMocks))
vi.mock('../ssh/ssh-target-registry', () => moduleMocks.sshModuleMock(reposMocks))

import { registerRepoHandlers } from './repos'
import { clearGitCapabilityStateForTests } from '../git/git-capability-state'
import { resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { createRepoHandlerHarness } from './repos-remote-test-harness'
import { REPO_SEARCH_REFS_MAX_LIMIT } from '../../shared/repo-search-limits'

const { handleMock, mockStore, mockGitProvider, prepareLocalWorktreeRootForRepoMock } = reposMocks

beforeEach(() => {
  clearGitCapabilityStateForTests()
  resetSshProviderAuthorities()
})

describe('repos:getBaseRefDefault envelope', () => {
  const { handlers, mockWindow, captureHandlers } = createRepoHandlerHarness()

  beforeEach(() => {
    captureHandlers(handleMock)
    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.getRepo.mockReset()
    prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)
    // Reset exec so a newly added test doesn't inherit the previous test's exec mock.
    mockGitProvider.exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    registerRepoHandlers(mockWindow as never, mockStore as never, {} as never)
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

  // Why: the handler resolves default-ref and remote-count in parallel, so dispatch on argv (not call order) to stay stable.
  type ExecResponse = { stdout: string; stderr: string }
  type ExecRule = {
    matches: (argv: string[]) => boolean
    respond: () => Promise<ExecResponse>
  }
  const dispatchExec = (rules: ExecRule[]): ((argv: string[]) => Promise<ExecResponse>) => {
    return (argv: string[]) => {
      for (const rule of rules) {
        if (rule.matches(argv)) {
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
          matches: isSymbolicRef,
          respond: () => Promise.resolve({ stdout: 'refs/remotes/origin/main\n', stderr: '' })
        },
        // origin/HEAD is verified before trusted, so it must also resolve via rev-parse.
        {
          matches: isRevParseFor('refs/remotes/origin/main'),
          respond: () => Promise.resolve({ stdout: '', stderr: '' })
        },
        {
          matches: isRemoteList,
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
          matches: isSymbolicRef,
          respond: () => Promise.resolve({ stdout: 'refs/remotes/origin/main\n', stderr: '' })
        },
        // origin/HEAD is verified before trusted, so it must also resolve via rev-parse.
        {
          matches: isRevParseFor('refs/remotes/origin/main'),
          respond: () => Promise.resolve({ stdout: '', stderr: '' })
        },
        {
          matches: isRemoteList,
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

    // Why: default detection is independent of remote-count; a failing count falls back to 0 while the default still resolves.
    expect(result.defaultBaseRef).toBe('origin/main')
    expect(result.remoteCount).toBe(0)
  })

  it('falls back through probes over SSH when symbolic-ref fails', async () => {
    mockGitProvider.exec = vi.fn().mockImplementation(
      dispatchExec([
        // symbolic-ref rejects (no origin/HEAD on the remote)
        { matches: isSymbolicRef, respond: () => Promise.reject(new Error('no symbolic-ref')) },
        // probe 1: refs/remotes/origin/main — rejects
        {
          matches: isRevParseFor('refs/remotes/origin/main'),
          respond: () => Promise.reject(new Error('missing'))
        },
        // probe 2: refs/remotes/origin/master — succeeds
        {
          matches: isRevParseFor('refs/remotes/origin/master'),
          respond: () => Promise.resolve({ stdout: 'abc123\n', stderr: '' })
        },
        {
          matches: isRemoteList,
          respond: () => Promise.resolve({ stdout: 'origin\n', stderr: '' })
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

    // Why: when symbolic-ref fails, the probe chain resolves origin/master, matching the local path.
    expect(result.defaultBaseRef).toBe('origin/master')
    expect(result.remoteCount).toBe(1)
  })
})

describe('repos:searchBaseRefs SSH relay', () => {
  const { handlers, mockWindow, captureHandlers } = createRepoHandlerHarness()

  beforeEach(() => {
    captureHandlers(handleMock)
    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.getRepo.mockReset()
    prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)
    mockGitProvider.exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    registerRepoHandlers(mockWindow as never, mockStore as never, {} as never)
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

  it('returns refs for an empty query so remote Branch pickers open populated', async () => {
    const stdout = [
      'refs/remotes/origin/main\0origin/main',
      'refs/remotes/upstream/feature-x\0upstream/feature-x'
    ].join('\n')
    mockGitProvider.exec = vi.fn().mockImplementation((argv: string[]) => {
      if (argv[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\nupstream\n', stderr: '' })
      }
      return Promise.resolve({ stdout, stderr: '' })
    })
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

    expect(result).toEqual(['origin/main', 'upstream/feature-x'])
    expect(mockGitProvider.exec).toHaveBeenCalledTimes(2)
    const [argv] = mockGitProvider.exec.mock.calls.find(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )!
    expect(argv.some((arg: string) => arg.startsWith('--exclude=refs/remotes/'))).toBe(true)
    expect(argv).toContain('--count=100')
    expect(argv).toContain('refs/heads/**/**')
    expect(argv).toContain('refs/heads/**/**/**')
    expect(argv).toContain('refs/remotes/**/**')
    expect(argv).toContain('refs/remotes/**/**/**')
  })

  it('sanitizes glob metacharacter-only queries into the empty-query branch list', async () => {
    mockGitProvider.exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: '***'
    })

    // Why: glob metacharacters are stripped, so the empty query intentionally lists refs.
    const [argv] = mockGitProvider.exec.mock.calls.find(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )!
    expect(argv.some((arg: string) => arg.startsWith('--exclude=refs/remotes/'))).toBe(true)
    expect(argv).toContain('--count=100')
    expect(argv).toContain('refs/heads/**/**')
    expect(argv).toContain('refs/heads/**/**/**')
    expect(argv).toContain('refs/remotes/**/**')
    expect(argv).toContain('refs/remotes/**/**/**')
  })

  it('rejects invalid limits before building broad relay searches', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: '',
      limit: 0.5
    })

    expect(result).toEqual([])
    expect(mockGitProvider.exec).not.toHaveBeenCalled()
  })

  it('clamps oversized limits before building broad relay searches', async () => {
    mockGitProvider.exec = vi.fn().mockImplementation((argv: string[]) => {
      if (argv[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\n', stderr: '' })
      }
      return Promise.resolve({
        stdout: 'refs/remotes/origin/main\0origin/main',
        stderr: ''
      })
    })
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: '',
      limit: REPO_SEARCH_REFS_MAX_LIMIT + 1
    })

    expect(result).toEqual(['origin/main'])
    const forEachRefCall = mockGitProvider.exec.mock.calls.find(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )
    expect(forEachRefCall?.[0]).toContain('--count=4000')
  })

  it('retries without --exclude for older git on SSH hosts', async () => {
    const stdout = [
      'refs/remotes/origin/main\0origin/main',
      'refs/remotes/origin/HEAD\0origin/HEAD'
    ].join('\n')
    mockGitProvider.exec = vi.fn().mockImplementation((argv: string[]) => {
      if (argv[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\n', stderr: '' })
      }
      if (argv.some((arg) => arg.startsWith('--exclude=refs/remotes/'))) {
        return Promise.reject(
          Object.assign(new Error("unknown option `exclude'"), {
            stderr: "error: unknown option `exclude'"
          })
        )
      }
      return Promise.resolve({ stdout, stderr: '' })
    })
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: '',
      limit: 1
    })
    const repeatedResult = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: '',
      limit: 1
    })

    expect(result).toEqual(['origin/main'])
    expect(repeatedResult).toEqual(['origin/main'])
    const forEachRefCalls = mockGitProvider.exec.mock.calls.filter(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )
    expect(forEachRefCalls).toHaveLength(3)
    expect(
      (forEachRefCalls[0][0] as string[]).some((arg) => arg.startsWith('--exclude=refs/remotes/'))
    ).toBe(true)
    expect(
      (forEachRefCalls[1][0] as string[]).some((arg) => arg.startsWith('--exclude=refs/remotes/'))
    ).toBe(false)
    expect(forEachRefCalls[1][0]).toContain('--count=104')
    expect(
      (forEachRefCalls[2][0] as string[]).some((arg) => arg.startsWith('--exclude=refs/remotes/'))
    ).toBe(false)
  })

  it('sends the widened `**` argv so all remotes and slash-named branches are discoverable', async () => {
    // Why: SSH globs all remotes and `**` crosses `/` so slash-named branches match a single-word query (issue #624).
    mockGitProvider.exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    await handlers.get('repos:searchBaseRefs')!(null, { repoId: 'r1', query: 'upstream' })

    expect(mockGitProvider.exec).toHaveBeenCalledTimes(2)
    const [argv, path] = mockGitProvider.exec.mock.calls.find(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )!
    expect(path).toBe('/remote/repo')
    expect(argv[0]).toBe('for-each-ref')
    expect(argv).toContain('refs/heads/**/*upstream*')
    expect(argv).toContain('refs/heads/**/*upstream*/**')
    expect(argv).toContain('refs/remotes/**/*upstream*')
    expect(argv).toContain('refs/remotes/**/*upstream*/**')
    // Guard against regression to the old origin-only glob.
    expect(argv).not.toContain('refs/remotes/origin/*upstream*')
    expect(mockGitProvider.exec).toHaveBeenCalledWith(['remote'], '/remote/repo')
  })

  it('sends segmented argv for display-format queries like `upstream/main`', async () => {
    // Why: a single `*<q>*` glob with a literal `/` makes SSH multi-segment queries silently match nothing (issue #624 shape).
    mockGitProvider.exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    await handlers.get('repos:searchBaseRefs')!(null, { repoId: 'r1', query: 'upstream/main' })

    expect(mockGitProvider.exec).toHaveBeenCalledTimes(3)
    const forEachRefCalls = mockGitProvider.exec.mock.calls.filter(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )
    expect(forEachRefCalls).toHaveLength(2)
    const segmentedArgv = forEachRefCalls[0][0] as string[]
    const branchRootArgv = forEachRefCalls[1][0] as string[]
    expect(segmentedArgv).toContain('refs/remotes/*upstream*/*main*')
    expect(segmentedArgv).toContain('refs/heads/*upstream*/*main*')
    expect(branchRootArgv).toContain('refs/remotes/*/upstream/main*')
    expect(branchRootArgv).toContain('refs/heads/upstream/main*')
    // Regression guard: a literal slash must never appear inside a single segmented glob (`*` doesn't cross `/`).
    expect(segmentedArgv).not.toContain('refs/remotes/*upstream/main*/*')
    expect(segmentedArgv).not.toContain('refs/remotes/*/*upstream/main*')
    expect(mockGitProvider.exec).toHaveBeenCalledWith(['remote'], '/remote/repo')
  })

  it('parses NUL-delimited stdout and filters <remote>/HEAD pseudo-refs', async () => {
    // Why: confirms the HEAD filter works for any remote, not just origin, on the SSH path.
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

    // Why: transport failure falls back to an empty result set so the picker doesn't crash.
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
