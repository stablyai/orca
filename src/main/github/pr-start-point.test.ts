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
      remoteName: 'pr-contributor-orca',
      branchName: 'feat/onboarding-model-choice-782',
      remoteUrl: 'git@github.com:contributor/orca.git'
    })
    const gitExec = vi.fn(async (args: string[]) => {
      if (args[0] === 'fetch' && String(args[2]).startsWith('+refs/heads/')) {
        throw new Error('fatal: could not find remote ref')
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
      resolveRemote: async () => 'origin'
    })

    expect(gitExec).toHaveBeenCalledWith([
      'fetch',
      'origin',
      '+refs/heads/feat/onboarding-model-choice-782:refs/remotes/origin/feat/onboarding-model-choice-782'
    ])
    expect(gitExec).toHaveBeenCalledWith(['fetch', 'origin', 'refs/pull/1849/head'])
    expect(result).toEqual({
      baseBranch: 'def456',
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'feat/onboarding-model-choice-782',
        remoteUrl: 'git@github.com:contributor/orca.git'
      }
    })
  })

  it('keeps the PR head ref fallback when push-target discovery also fails', async () => {
    getPullRequestPushTargetMock.mockRejectedValue(new Error('head repo is unavailable'))
    const gitExec = vi.fn(async (args: string[]) => {
      if (args[0] === 'fetch' && String(args[2]).startsWith('+refs/heads/')) {
        throw new Error('fatal: could not find remote ref')
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
      resolveRemote: async () => 'origin'
    })

    expect(getPullRequestPushTargetMock).toHaveBeenCalledWith('/repo-root', 1849, null)
    expect(result).toEqual({ baseBranch: 'def456' })
  })

  it('resolves an inaccessible fork PR even when push-target discovery fails', async () => {
    getPullRequestPushTargetMock.mockRejectedValue(new Error('head repo is unavailable'))
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
      resolveRemote: async () => 'origin'
    })

    expect(getPullRequestPushTargetMock).toHaveBeenCalledWith('/repo-root', 1849, null)
    expect(gitExec).toHaveBeenCalledWith(['fetch', 'origin', 'refs/pull/1849/head'])
    expect(result).toEqual({ baseBranch: 'abc123' })
  })

  it('uses PR metadata when the caller did not pass a head ref', async () => {
    getWorkItemMock.mockResolvedValue({
      type: 'pr',
      branchName: 'contributor/fix',
      isCrossRepository: true
    })
    getPullRequestPushTargetMock.mockResolvedValue({
      remoteName: 'pr-contributor-orca',
      branchName: 'contributor/fix',
      remoteUrl: 'git@github.com:contributor/orca.git'
    })
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
      resolveRemote: async () => 'origin'
    })

    expect(getWorkItemMock).toHaveBeenCalledWith('/repo-root', 1738, 'pr', null)
    expect(result).toEqual({
      baseBranch: 'abc123',
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'contributor/fix',
        remoteUrl: 'git@github.com:contributor/orca.git'
      }
    })
  })

  it('returns the verified head SHA, branch override, and push target when same-repo branch fetch succeeds', async () => {
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
      gitExec,
      resolveRemote: async () => 'origin'
    })

    expect(gitExec).toHaveBeenCalledWith([
      'fetch',
      'origin',
      '+refs/heads/feature/add-feature:refs/remotes/origin/feature/add-feature'
    ])
    expect(gitExec).toHaveBeenCalledWith(['rev-parse', '--verify', 'origin/feature/add-feature'])
    expect(result).toEqual({
      baseBranch: 'abc123',
      headSha: 'abc123',
      branchNameOverride: 'feature/add-feature',
      pushTarget: { remoteName: 'origin', branchName: 'feature/add-feature' }
    })
  })
})
