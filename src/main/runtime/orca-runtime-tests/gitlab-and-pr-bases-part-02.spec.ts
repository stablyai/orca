import { describe, expect, it, vi } from 'vitest'
import {
  ORIGIN_HEAD_COMPONENT,
  ORIGIN_REMOTE_URL,
  OrcaRuntimeService,
  REVIEW_HEAD_FETCH_TIMEOUT_MS,
  getGitLabProjectRefForRemoteMock,
  getGitLabWorkItemByProjectRefMock,
  getGlabKnownHostsMock,
  getPullRequestPushTargetMock,
  gitRunner,
  registerSshGitProvider,
  setPlatform
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_REPO_PATH,
  isOriginMainBaseRefProbe,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('records GitLab pasted-project recents only after successful runtime lookup', async () => {
    let settings = {
      ...store.getSettings(),
      gitlabProjects: {
        pinned: [{ host: 'gitlab.example.com', path: 'group/pinned' }],
        recent: []
      }
    }
    const updateSettings = vi.fn((updates: Record<string, unknown>) => {
      settings = { ...settings, ...updates } as typeof settings
    })
    const runtimeStore = {
      ...store,
      getSettings: () => settings,
      updateSettings
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    getGitLabWorkItemByProjectRefMock.mockResolvedValueOnce({
      id: 'gitlab-issue-7',
      type: 'issue',
      number: 7
    })
    await runtime.getGitLabRepoWorkItemByPath(
      TEST_REPO_ID,
      { host: 'gitlab.example.com', path: 'group/project' },
      7,
      'issue'
    )

    expect(updateSettings).toHaveBeenCalledWith({
      gitlabProjects: {
        pinned: [{ host: 'gitlab.example.com', path: 'group/pinned' }],
        recent: [
          expect.objectContaining({
            host: 'gitlab.example.com',
            path: 'group/project',
            lastOpenedAt: expect.any(String)
          })
        ]
      }
    })

    updateSettings.mockClear()
    getGitLabWorkItemByProjectRefMock.mockResolvedValueOnce(null)
    await runtime.getGitLabRepoWorkItemByPath(
      TEST_REPO_ID,
      { host: 'gitlab.example.com', path: 'group/missing' },
      404,
      'issue'
    )

    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('threads explicit origin preference through runtime WSL PR base resolution', async () => {
    setPlatform('win32')
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined),
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'repo',
          badgeColor: 'blue',
          sourceRepoIds: [TEST_REPO_ID],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getSettings: () => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      if (isOriginMainBaseRefProbe(args)) {
        return { stdout: 'main-sha\n', stderr: '' }
      }
      if (args[0] === 'config') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        if (args[2] !== 'origin' && args[2] !== 'upstream') {
          throw new Error(`unexpected remote: ${String(args[2])}`)
        }
        const url =
          args[2] === 'origin'
            ? 'git@github.com:org/repo.git'
            : 'git@github.com:org/upstream-repo.git'
        return { stdout: `${url}\n`, stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\nupstream\n', stderr: '' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === 'origin/feature/add-feature'
      ) {
        return { stdout: 'pr-head-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    try {
      const result = await runtime.resolveManagedPrBase({
        repoSelector: 'id:repo-1',
        prNumber: 42,
        headRefName: 'feature/add-feature',
        isCrossRepository: false
      })

      expect(result).toMatchObject({
        baseBranch: 'pr-head-sha',
        headSha: 'pr-head-sha',
        branchNameOverride: 'feature/add-feature'
      })
      expect(gitSpy).toHaveBeenCalledWith(
        [
          'fetch',
          'origin',
          '+refs/heads/feature/add-feature:refs/remotes/origin/feature/add-feature'
        ],
        { cwd: TEST_REPO_PATH, wslDistro: 'Ubuntu' }
      )
      expect(gitSpy).toHaveBeenCalledWith(['rev-parse', '--verify', 'origin/feature/add-feature'], {
        cwd: TEST_REPO_PATH,
        wslDistro: 'Ubuntu'
      })
      // Why: the explicit origin preference must short-circuit before any
      // identity probe, so no remote — not just upstream — gets a get-url.
      expect(gitSpy).not.toHaveBeenCalledWith(
        ['remote', 'get-url', expect.anything()],
        expect.anything()
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('resolves SSH GitHub fork PR heads through the write-capable fetch RPC', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'remote' && args[1] === 'get-url') {
          return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
        }
        if (args[0] === 'remote') {
          return { stdout: 'origin\nupstream\n', stderr: '' }
        }
        if (
          args[0] === 'rev-parse' &&
          args[2] === `refs/orca/pull/${ORIGIN_HEAD_COMPONENT}/42^{commit}`
        ) {
          return { stdout: 'remote-fork-pr-sha\n', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      fetchGitHubPullRequestHead: vi
        .fn()
        .mockResolvedValue(`refs/orca/pull/${ORIGIN_HEAD_COMPONENT}/42`),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.resolveManagedPrBase({
      repoSelector: 'id:repo-1',
      prNumber: 42,
      headRefName: 'contributor/fix',
      isCrossRepository: true
    })

    expect(result).toEqual({
      baseBranch: 'remote-fork-pr-sha',
      headSha: 'remote-fork-pr-sha',
      branchNameOverride: 'contributor/fix'
    })
    expect(provider.fetchGitHubPullRequestHead).toHaveBeenCalledWith('/remote/repo', 'origin', 42)
    expect(getPullRequestPushTargetMock).toHaveBeenCalledWith(
      '/remote/repo',
      42,
      'ssh-1',
      {},
      'origin'
    )
    expect(provider.exec).not.toHaveBeenCalledWith(
      expect.arrayContaining(['fetch']),
      '/remote/repo'
    )
  })

  it('resolves local GitLab fork MR bases from the target project MR head ref', async () => {
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`
      ) {
        return { stdout: 'fork-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        targetBranch: 'main',
        isCrossRepository: true
      })

      expect(result).toEqual({
        baseBranch: 'fork-mr-sha',
        compareBaseRef: 'refs/remotes/origin/main'
      })
      expect(gitSpy).toHaveBeenCalledWith(
        [
          'fetch',
          '--no-tags',
          'origin',
          `+refs/merge-requests/42/head:refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42`
        ],
        { cwd: TEST_REPO_PATH, timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
      )
      expect(gitSpy).toHaveBeenCalledWith(
        ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
        { cwd: TEST_REPO_PATH }
      )
      expect(gitSpy).toHaveBeenCalledWith(
        ['rev-parse', '--verify', `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`],
        { cwd: TEST_REPO_PATH }
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('captures the fork MR head from a dedicated ref, not the shared FETCH_HEAD', async () => {
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    // Why: simulate a concurrent `git fetch origin` clobbering FETCH_HEAD with the
    // default-branch tip. The resolved base must come from the durable Orca MR ref.
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        const ref = args.at(-1)
        if (ref === 'FETCH_HEAD') {
          return { stdout: 'mainbranchtip000\n', stderr: '' }
        }
        if (ref === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`) {
          return { stdout: 'mrheadsha111\n', stderr: '' }
        }
        throw new Error(`unexpected rev-parse ref: ${ref}`)
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        targetBranch: 'main',
        isCrossRepository: true
      })

      expect(result).toEqual({
        baseBranch: 'mrheadsha111',
        compareBaseRef: 'refs/remotes/origin/main'
      })
      expect(gitSpy).not.toHaveBeenCalledWith(
        ['rev-parse', '--verify', 'FETCH_HEAD'],
        expect.anything()
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('keeps the durable MR head when the head fetch fails but the local ref resolves', async () => {
    // Why: mirror compare-base soft-keep — a transient fetch failure must not
    // fail the resolve when a prior fetch already pinned refs/orca/merge-requests/<iid>.
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'fetch' && args[1] === '--no-tags') {
        throw new Error('fatal: unable to access repo: Could not resolve host: gitlab.example')
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'rev-parse' &&
        args[2] === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`
      ) {
        return { stdout: 'pinned-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        targetBranch: 'main',
        isCrossRepository: true
      })

      expect(result).toEqual({
        baseBranch: 'pinned-mr-sha',
        compareBaseRef: 'refs/remotes/origin/main'
      })
    } finally {
      warnSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it.each([
    ["fatal: couldn't find remote ref refs/merge-requests/42/head", 'deleted MR / cleaned fork'],
    ['Authentication failed. Check your remote credentials.', 'auth failure'],
    [
      'This SSH host is running an older Orca relay that cannot fetch merge request heads. Reconnect to deploy the latest relay, then try again.',
      'stale relay'
    ]
  ])('fails hard instead of soft-keeping the durable MR head on: %s', async (message) => {
    // Why: soft-keep on a non-transient failure would check out a dead or
    // unauthorized tip (or mask the reconnect prompt) with a success UX.
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'fetch' && args[1] === '--no-tags') {
        throw new Error(message)
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'rev-parse' &&
        args[2] === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`
      ) {
        return { stdout: 'pinned-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        targetBranch: 'main',
        isCrossRepository: true
      })

      expect(result).toEqual({
        error: `Failed to fetch refs/merge-requests/42/head: ${message}`
      })
      expect(gitSpy).not.toHaveBeenCalledWith(
        ['rev-parse', '--verify', `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`],
        expect.anything()
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('routes runtime GitLab fork MR base git calls through the selected WSL project runtime', async () => {
    setPlatform('win32')
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined),
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'repo',
          badgeColor: 'blue',
          sourceRepoIds: [TEST_REPO_ID],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getSettings: () => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`
      ) {
        return { stdout: 'fork-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com', 'git.internal'])
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        isCrossRepository: true
      })

      expect(result).toEqual({ baseBranch: 'fork-mr-sha' })
      expect(getGitLabProjectRefForRemoteMock).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        'origin',
        ['gitlab.com', 'git.internal'],
        null,
        { wslDistro: 'Ubuntu' }
      )
      expect(gitSpy).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
        cwd: TEST_REPO_PATH,
        wslDistro: 'Ubuntu'
      })
      expect(gitSpy).toHaveBeenCalledWith(
        [
          'fetch',
          '--no-tags',
          'origin',
          `+refs/merge-requests/42/head:refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42`
        ],
        { cwd: TEST_REPO_PATH, wslDistro: 'Ubuntu', timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
      )
      expect(gitSpy).toHaveBeenCalledWith(
        ['rev-parse', '--verify', `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`],
        { cwd: TEST_REPO_PATH, wslDistro: 'Ubuntu' }
      )
    } finally {
      gitSpy.mockRestore()
    }
  })
})
