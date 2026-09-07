import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getPullRequestPushTargetMock } = vi.hoisted(() => ({
  getPullRequestPushTargetMock: vi.fn()
}))

vi.mock('./client', () => ({
  getPullRequestPushTarget: getPullRequestPushTargetMock,
  getWorkItem: vi.fn()
}))

import { resolveGitHubPrStartPoint } from './pr-start-point'
import { reviewHeadRemoteRefComponent } from '../../shared/review-head-tracking-ref'

const ORIGIN_URL = 'git@github.com:acme/orca.git'
const durablePrLocalRef = `refs/orca/pull/${reviewHeadRemoteRefComponent('origin', ORIGIN_URL)}/42`
const durablePrRev = `${durablePrLocalRef}^{commit}`

describe('resolveGitHubPrStartPoint compare base', () => {
  beforeEach(() => {
    getPullRequestPushTargetMock.mockReset()
    getPullRequestPushTargetMock.mockResolvedValue(null)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('drops the compare base for a fork PR when its base ref is missing locally too', async () => {
    const fetchRemoteTrackingRef = vi.fn(async () => {
      throw new Error("fatal: couldn't find remote ref refs/heads/main")
    })
    const fetchPullRequestHeadRef = vi.fn(async () => durablePrLocalRef)
    // Why: durable ref for the head resolves; the compare base does not exist.
    const gitExec = vi.fn(async (args: string[]) => {
      if (args[2] === durablePrRev) {
        return { stdout: 'fork-head-sha\n', stderr: '' }
      }
      throw new Error('fatal: Needed a single revision')
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 42,
      headRefName: 'contributor/fix',
      baseRefName: 'main',
      isCrossRepository: true,
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef,
      resolveRemote: async () => 'origin'
    })

    // Why: guards against a FETCH_HEAD regression — the head must resolve via the durable ref.
    expect(gitExec).toHaveBeenCalledWith(['rev-parse', '--verify', durablePrRev])
    expect(result).toEqual({
      baseBranch: 'fork-head-sha',
      headSha: 'fork-head-sha',
      branchNameOverride: 'contributor/fix'
    })
    expect(console.warn).toHaveBeenCalledWith(
      '[github:resolvePrStartPoint] optional compare-base fetch failed',
      expect.objectContaining({ baseRefName: 'main', prNumber: 42, localBaseResolved: false })
    )
  })

  it('keeps the compare base for a fork PR when the local tracking ref still resolves', async () => {
    const fetchRemoteTrackingRef = vi.fn(async () => {
      // Why: transient network failure — the previously-fetched base is still on disk.
      throw new Error('fatal: unable to access repo: Could not resolve host: github.com')
    })
    const fetchPullRequestHeadRef = vi.fn(async () => durablePrLocalRef)
    const gitExec = vi.fn(async (args: string[]) => {
      if (args[2] === durablePrRev) {
        return { stdout: 'fork-head-sha\n', stderr: '' }
      }
      if (args[2] === 'refs/remotes/origin/main^{commit}') {
        return { stdout: 'base-commit-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 42,
      headRefName: 'contributor/fix',
      baseRefName: 'main',
      isCrossRepository: true,
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef,
      resolveRemote: async () => 'origin'
    })

    // Why: create-time baseRef metadata must be the compare base, not the PR head SHA.
    expect(result).toEqual({
      baseBranch: 'fork-head-sha',
      compareBaseRef: 'refs/remotes/origin/main',
      headSha: 'fork-head-sha',
      branchNameOverride: 'contributor/fix'
    })
    expect(gitExec).toHaveBeenCalledWith([
      'rev-parse',
      '--verify',
      'refs/remotes/origin/main^{commit}'
    ])
  })

  it('keeps a same-repo PR compare base when the fetch fails but the local ref resolves', async () => {
    const fetchRemoteTrackingRef = vi.fn(async (_remote: string, branch: string) => {
      if (branch === 'main') {
        throw new Error('network unavailable')
      }
    })
    const gitExec = vi.fn(async (args: string[]) => {
      if (args[2] === 'refs/remotes/origin/main^{commit}') {
        return { stdout: 'base-commit-sha\n', stderr: '' }
      }
      return { stdout: 'same-repo-head-sha\n', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 43,
      headRefName: 'feature/fix',
      baseRefName: 'main',
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: async () => durablePrLocalRef,
      resolveRemote: async () => 'origin'
    })

    expect(result).toEqual({
      baseBranch: 'same-repo-head-sha',
      compareBaseRef: 'refs/remotes/origin/main',
      headSha: 'same-repo-head-sha',
      branchNameOverride: 'feature/fix',
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })
  })

  it('drops a same-repo PR compare base when neither fetch nor local ref resolves', async () => {
    const fetchRemoteTrackingRef = vi.fn(async (_remote: string, branch: string) => {
      if (branch === 'main') {
        throw new Error('network unavailable')
      }
    })
    const gitExec = vi.fn(async (args: string[]) => {
      if (args[2] === 'refs/remotes/origin/main^{commit}') {
        throw new Error('fatal: Needed a single revision')
      }
      return { stdout: 'same-repo-head-sha\n', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 44,
      headRefName: 'feature/fix',
      baseRefName: 'main',
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: async () => durablePrLocalRef,
      resolveRemote: async () => 'origin'
    })

    expect(result).toEqual({
      baseBranch: 'same-repo-head-sha',
      headSha: 'same-repo-head-sha',
      branchNameOverride: 'feature/fix',
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })
  })
})
