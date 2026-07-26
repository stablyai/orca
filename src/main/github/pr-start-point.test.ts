import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getPullRequestPushTargetMock, getWorkItemMock } = vi.hoisted(() => ({
  getPullRequestPushTargetMock: vi.fn(),
  getWorkItemMock: vi.fn()
}))

vi.mock('./client', () => ({
  getPullRequestPushTarget: getPullRequestPushTargetMock,
  getWorkItem: getWorkItemMock
}))

import { resolveGitHubPrStartPoint } from './pr-start-point'
import { reviewHeadRemoteRefComponent } from '../../shared/review-head-tracking-ref'

const ORIGIN_URL = 'git@github.com:acme/orca.git'
const ORIGIN_COMPONENT = reviewHeadRemoteRefComponent('origin', ORIGIN_URL)
const durablePrLocalRef = (prNumber: number): string =>
  `refs/orca/pull/${ORIGIN_COMPONENT}/${prNumber}`
const durablePrRev = (prNumber: number): string => `${durablePrLocalRef(prNumber)}^{commit}`
const remoteGetUrl = (args: string[]): { stdout: string; stderr: string } | null =>
  args[0] === 'remote' && args[1] === 'get-url' ? { stdout: `${ORIGIN_URL}\n`, stderr: '' } : null

describe('resolveGitHubPrStartPoint', () => {
  const fetchPullRequestHeadRefMock = vi.fn()

  beforeEach(() => {
    getPullRequestPushTargetMock.mockReset()
    getWorkItemMock.mockReset()
    fetchPullRequestHeadRefMock.mockReset()
    // Why: success path rev-parses the path the fetch returns (writer-authoritative).
    fetchPullRequestHeadRefMock.mockImplementation(async (_remote: string, prNumber: number) =>
      durablePrLocalRef(prNumber)
    )
  })

  it('falls back to the GitHub PR head ref when a direct branch fetch fails', async () => {
    getPullRequestPushTargetMock.mockResolvedValue({
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'fix-issue-6933',
        remoteUrl: 'git@github.com:contributor/orca.git'
      }
    })
    const fetchRemoteTrackingRef = vi.fn(async (_remote: string, branch: string) => {
      if (branch === 'fix-issue-6933') {
        throw new Error('fatal: could not find remote ref')
      }
    })
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'def456\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 6934,
      headRefName: 'fix-issue-6933',
      baseRefName: 'main',
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin'
    })

    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('origin', 'fix-issue-6933')
    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('origin', 'main')
    expect(fetchPullRequestHeadRefMock).toHaveBeenCalledWith('origin', 6934)
    expect(result).toEqual({
      baseBranch: 'def456',
      compareBaseRef: 'refs/remotes/origin/main',
      headSha: 'def456',
      branchNameOverride: 'fix-issue-6933',
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'fix-issue-6933',
        remoteUrl: 'git@github.com:contributor/orca.git'
      }
    })
  })

  it('keeps the PR head ref fallback when push-target discovery also fails', async () => {
    getPullRequestPushTargetMock.mockRejectedValue(new Error('head repo is unavailable'))
    const fetchRemoteTrackingRef = vi.fn(async () => {
      throw new Error('fatal: could not find remote ref')
    })
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'def456\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 1849,
      headRefName: 'feat/onboarding-model-choice-782',
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin'
    })

    expect(getPullRequestPushTargetMock).toHaveBeenCalledWith('/repo-root', 1849, null)
    expect(result).toEqual({
      baseBranch: 'def456',
      headSha: 'def456',
      branchNameOverride: 'feat/onboarding-model-choice-782'
    })
  })

  it('resolves an inaccessible fork PR even when push-target discovery fails', async () => {
    getPullRequestPushTargetMock.mockRejectedValue(new Error('head repo is unavailable'))
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 1849,
      headRefName: 'feat/onboarding-model-choice-782',
      isCrossRepository: true,
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin'
    })

    expect(getPullRequestPushTargetMock).toHaveBeenCalledWith('/repo-root', 1849, null)
    expect(fetchPullRequestHeadRefMock).toHaveBeenCalledWith('origin', 1849)
    expect(result).toEqual({
      baseBranch: 'abc123',
      headSha: 'abc123',
      branchNameOverride: 'feat/onboarding-model-choice-782'
    })
  })

  it('prefers the pull-head error when the branch miss triggered a failing fallback', async () => {
    // Why: the branch fetch missed and we fell back to refs/pull/<N>/head; the
    // fallback failure is the actionable one, not the original branch miss.
    const fetchRemoteTrackingRef = vi.fn(async () => {
      throw new Error('fatal: could not find remote ref refs/heads/feature/fix')
    })
    fetchPullRequestHeadRefMock.mockRejectedValue(
      new Error(
        'This SSH host is running an older Orca relay that cannot fetch pull request heads.'
      )
    )
    const gitExec = vi.fn(async () => ({ stdout: '', stderr: '' }))

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 77,
      headRefName: 'feature/fix',
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin'
    })

    expect(result).toEqual({
      error:
        'Failed to fetch refs/pull/77/head: This SSH host is running an older Orca relay that cannot fetch pull request heads.'
    })
  })

  it('captures the fork PR head from a dedicated ref, not the shared FETCH_HEAD', async () => {
    getPullRequestPushTargetMock.mockRejectedValue(new Error('head repo is unavailable'))
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    // Why: simulate a concurrent `git fetch origin` clobbering FETCH_HEAD with the
    // default-branch tip. The resolved start-point must come from the durable Orca ref.
    const gitExec = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        const ref = args.at(-1)
        if (ref === 'FETCH_HEAD') {
          return { stdout: 'mainbranchtip000\n', stderr: '' }
        }
        if (ref === durablePrRev(1849)) {
          return { stdout: 'prheadsha111\n', stderr: '' }
        }
        throw new Error(`unexpected rev-parse ref: ${ref}`)
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 1849,
      headRefName: 'feat/onboarding-model-choice-782',
      isCrossRepository: true,
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin'
    })

    expect(fetchPullRequestHeadRefMock).toHaveBeenCalledWith('origin', 1849)
    // Success path must not re-hash remote identity after the fetch returns a path.
    expect(gitExec).not.toHaveBeenCalledWith(['remote', 'get-url', 'origin'])
    expect(gitExec).not.toHaveBeenCalledWith(['rev-parse', '--verify', 'FETCH_HEAD'])
    expect(result).toEqual({
      baseBranch: 'prheadsha111',
      headSha: 'prheadsha111',
      branchNameOverride: 'feat/onboarding-model-choice-782'
    })
  })

  it('keeps the durable PR head when the head fetch fails but the local ref resolves', async () => {
    // Why: mirror compare-base soft-keep — a transient fetch failure must not
    // fail the resolve when a prior fetch already pinned refs/orca/pull/<N>.
    getPullRequestPushTargetMock.mockRejectedValue(new Error('head repo is unavailable'))
    fetchPullRequestHeadRefMock.mockRejectedValue(
      new Error('fatal: unable to access repo: Could not resolve host: github.com')
    )
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse' && args[2] === durablePrRev(1849)) {
        return { stdout: 'pinnedheadsha\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[2] === 'refs/remotes/origin/main^{commit}') {
        return { stdout: 'base-commit-sha\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const result = await resolveGitHubPrStartPoint({
        repoPath: '/repo-root',
        prNumber: 1849,
        headRefName: 'contributor/fix',
        baseRefName: 'main',
        isCrossRepository: true,
        gitExec,
        fetchRemoteTrackingRef,
        fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
        resolveRemote: async () => 'origin'
      })

      expect(result).toEqual({
        baseBranch: 'pinnedheadsha',
        compareBaseRef: 'refs/remotes/origin/main',
        headSha: 'pinnedheadsha',
        branchNameOverride: 'contributor/fix'
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it.each([
    ["fatal: couldn't find remote ref refs/pull/1849/head", 'deleted PR / cleaned fork'],
    ['Authentication failed. Check your remote credentials.', 'auth failure'],
    [
      'This SSH host is running an older Orca relay that cannot fetch pull request heads. Reconnect to deploy the latest relay, then try again.',
      'stale relay'
    ]
  ])('fails hard instead of soft-keeping the durable PR head on: %s', async (message) => {
    // Why: soft-keep on a non-transient failure would check out a dead or
    // unauthorized tip (or mask the reconnect prompt) with a success UX.
    getPullRequestPushTargetMock.mockRejectedValue(new Error('head repo is unavailable'))
    fetchPullRequestHeadRefMock.mockRejectedValue(new Error(message))
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse' && args[2] === durablePrRev(1849)) {
        return { stdout: 'pinnedheadsha\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 1849,
      headRefName: 'contributor/fix',
      baseRefName: 'main',
      isCrossRepository: true,
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin'
    })

    expect(result).toEqual({
      error: `Failed to fetch refs/pull/1849/head: ${message}`
    })
    expect(gitExec).not.toHaveBeenCalledWith(['rev-parse', '--verify', durablePrRev(1849)])
  })

  it('soft-keeps the durable PR head on an exec-timeout kill', async () => {
    getPullRequestPushTargetMock.mockRejectedValue(new Error('head repo is unavailable'))
    const timeoutError = Object.assign(new Error('Command failed: git fetch --no-tags origin'), {
      killed: true,
      signal: 'SIGTERM'
    })
    fetchPullRequestHeadRefMock.mockRejectedValue(timeoutError)
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse' && args[2] === durablePrRev(1849)) {
        return { stdout: 'pinnedheadsha\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const result = await resolveGitHubPrStartPoint({
        repoPath: '/repo-root',
        prNumber: 1849,
        headRefName: 'contributor/fix',
        isCrossRepository: true,
        gitExec,
        fetchRemoteTrackingRef,
        fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
        resolveRemote: async () => 'origin'
      })

      expect(result).toEqual({
        baseBranch: 'pinnedheadsha',
        headSha: 'pinnedheadsha',
        branchNameOverride: 'contributor/fix'
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('uses PR metadata when the caller did not pass a head ref', async () => {
    getWorkItemMock.mockResolvedValue({
      type: 'pr',
      branchName: 'contributor/fix',
      baseRefName: 'main',
      isCrossRepository: true
    })
    getPullRequestPushTargetMock.mockResolvedValue({
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'contributor/fix',
        remoteUrl: 'git@github.com:contributor/orca.git'
      }
    })
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 1738,
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin'
    })

    expect(getWorkItemMock).toHaveBeenCalledWith('/repo-root', 1738, 'pr', null)
    expect(result).toEqual({
      baseBranch: 'abc123',
      compareBaseRef: 'refs/remotes/origin/main',
      headSha: 'abc123',
      branchNameOverride: 'contributor/fix',
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'contributor/fix',
        remoteUrl: 'git@github.com:contributor/orca.git'
      }
    })
  })

  it('surfaces maintainerCanModify=false for a fork PR so the caller can warn', async () => {
    getPullRequestPushTargetMock.mockResolvedValue({
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'contributor/fix',
        remoteUrl: 'git@github.com:contributor/orca.git'
      },
      maintainerCanModify: false
    })
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 1849,
      headRefName: 'contributor/fix',
      isCrossRepository: true,
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin'
    })

    expect(result).toEqual({
      baseBranch: 'abc123',
      headSha: 'abc123',
      branchNameOverride: 'contributor/fix',
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'contributor/fix',
        remoteUrl: 'git@github.com:contributor/orca.git'
      },
      maintainerCanModify: false
    })
  })

  it('returns the verified head SHA, branch override, and push target when same-repo branch fetch succeeds', async () => {
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 42,
      headRefName: 'feature/add-feature',
      baseRefName: 'develop',
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin'
    })

    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('origin', 'feature/add-feature')
    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('origin', 'develop')
    expect(gitExec).toHaveBeenCalledWith(['rev-parse', '--verify', 'origin/feature/add-feature'])
    expect(result).toEqual({
      baseBranch: 'abc123',
      compareBaseRef: 'refs/remotes/origin/develop',
      headSha: 'abc123',
      branchNameOverride: 'feature/add-feature',
      pushTarget: { remoteName: 'origin', branchName: 'feature/add-feature' }
    })
  })
})
