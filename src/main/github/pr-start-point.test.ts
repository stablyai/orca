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

describe('resolveGitHubPrStartPoint', () => {
  beforeEach(() => {
    getPullRequestPushTargetMock.mockReset()
    getWorkItemMock.mockReset()
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
      resolveRemote: async () => 'origin',
      resolveRemoteAlternatives: async () => []
    })

    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('origin', 'fix-issue-6933')
    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('origin', 'main')
    expect(gitExec).toHaveBeenCalledWith(['fetch', 'origin', 'refs/pull/6934/head'])
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
      resolveRemote: async () => 'origin',
      resolveRemoteAlternatives: async () => []
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
      resolveRemote: async () => 'origin',
      resolveRemoteAlternatives: async () => []
    })

    expect(getPullRequestPushTargetMock).toHaveBeenCalledWith('/repo-root', 1849, null)
    expect(gitExec).toHaveBeenCalledWith(['fetch', 'origin', 'refs/pull/1849/head'])
    expect(result).toEqual({
      baseBranch: 'abc123',
      headSha: 'abc123',
      branchNameOverride: 'feat/onboarding-model-choice-782'
    })
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
      resolveRemote: async () => 'origin',
      resolveRemoteAlternatives: async () => []
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
      resolveRemote: async () => 'origin',
      resolveRemoteAlternatives: async () => []
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
      resolveRemote: async () => 'origin',
      resolveRemoteAlternatives: async () => []
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

  // Why: covers the multi-remote bug where the alphabetic-first remote (e.g.
  // `yzc`) lacks the PR branch, so the resolver must walk `origin` next.
  it('falls back to an alternate remote when the primary returns missing-ref', async () => {
    const fetchRemoteTrackingRef = vi.fn(async (remote: string, branch: string) => {
      if (remote === 'yzc' && branch === 'fix/qweather-agent-tool-port') {
        throw new Error('fatal: could not find remote ref fix/qweather-agent-tool-port')
      }
    })
    const gitExec = vi.fn(async (args: string[]) => {
      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === 'origin/fix/qweather-agent-tool-port'
      ) {
        return { stdout: 'deadbeef\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 4711,
      headRefName: 'fix/qweather-agent-tool-port',
      baseRefName: 'main',
      gitExec,
      fetchRemoteTrackingRef,
      resolveRemote: async () => 'yzc',
      resolveRemoteAlternatives: async () => ['origin']
    })

    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('yzc', 'fix/qweather-agent-tool-port')
    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('origin', 'fix/qweather-agent-tool-port')
    expect(gitExec).toHaveBeenCalledWith([
      'rev-parse',
      '--verify',
      'origin/fix/qweather-agent-tool-port'
    ])
    expect(result).toEqual({
      baseBranch: 'deadbeef',
      compareBaseRef: 'refs/remotes/origin/main',
      headSha: 'deadbeef',
      branchNameOverride: 'fix/qweather-agent-tool-port',
      pushTarget: { remoteName: 'origin', branchName: 'fix/qweather-agent-tool-port' }
    })
  })

  // Why: reproduces the exact bug-report failure. The git runner rejects with
  // `.message = "Command failed: git fetch yzc …"` (no missing-ref text) and
  // stashes git's `fatal: couldn't find remote ref …` in `.stderr`. The
  // resolver must read `.stderr` to recognize the missing ref and walk to
  // `origin`, otherwise it would surface the bogus `Failed to fetch yzc/…`.
  it('falls back to an alternate remote when the primary error hides the missing ref in .stderr', async () => {
    const fetchRemoteTrackingRef = vi.fn(async (remote: string, branch: string) => {
      if (remote === 'yzc' && branch === 'fix/qweather-agent-tool-port') {
        throw Object.assign(
          new Error(
            'Command failed: git fetch yzc +refs/heads/fix/qweather-agent-tool-port:refs/remotes/yzc/fix/qweather-agent-tool-port'
          ),
          { stderr: "fatal: couldn't find remote ref refs/heads/fix/qweather-agent-tool-port" }
        )
      }
    })
    const gitExec = vi.fn(async (args: string[]) => {
      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === 'origin/fix/qweather-agent-tool-port'
      ) {
        return { stdout: 'deadbeef\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 4711,
      headRefName: 'fix/qweather-agent-tool-port',
      baseRefName: 'main',
      gitExec,
      fetchRemoteTrackingRef,
      resolveRemote: async () => 'yzc',
      resolveRemoteAlternatives: async () => ['origin']
    })

    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('yzc', 'fix/qweather-agent-tool-port')
    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('origin', 'fix/qweather-agent-tool-port')
    expect(result).toEqual({
      baseBranch: 'deadbeef',
      compareBaseRef: 'refs/remotes/origin/main',
      headSha: 'deadbeef',
      branchNameOverride: 'fix/qweather-agent-tool-port',
      pushTarget: { remoteName: 'origin', branchName: 'fix/qweather-agent-tool-port' }
    })
  })

  // Why: surfaces the original bug report's error message when every configured
  // remote is missing the branch. The user-visible message used to read
  // `Failed to fetch <primary>/<branch>` even when an alternate remote could
  // have served the ref.
  it('reports the configured remotes when none can resolve the head branch', async () => {
    const fetchRemoteTrackingRef = vi.fn(async () => {
      throw new Error('fatal: could not find remote ref')
    })
    const gitExec = vi.fn(async (args: string[]) => {
      if (args[0] === 'fetch' && args[2] === 'refs/pull/42/head') {
        throw new Error('fatal: could not find remote ref refs/pull/42/head')
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 42,
      headRefName: 'feature/missing',
      baseRefName: 'main',
      gitExec,
      fetchRemoteTrackingRef,
      resolveRemote: async () => 'yzc',
      resolveRemoteAlternatives: async () => ['origin', 'backup']
    })

    expect(result.error).toBe(
      'Failed to fetch feature/missing (or refs/pull/42/head) from any configured remote (yzc, origin, backup).'
    )
    // Why: the refs/pull/<N>/head fallback must also probe alternatives before
    // returning an error — here every remote rejects the same way, so the
    // iteration visits each candidate before bubbling up the unified error.
    expect(gitExec).toHaveBeenCalledWith(['fetch', 'yzc', 'refs/pull/42/head'])
    expect(gitExec).toHaveBeenCalledWith(['fetch', 'origin', 'refs/pull/42/head'])
    expect(gitExec).toHaveBeenCalledWith(['fetch', 'backup', 'refs/pull/42/head'])
  })
})
