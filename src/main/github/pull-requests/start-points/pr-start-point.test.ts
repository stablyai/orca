import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getPullRequestPushTargetMock, getWorkItemMock } = vi.hoisted(() => ({
  getPullRequestPushTargetMock: vi.fn(),
  getWorkItemMock: vi.fn()
}))

vi.mock('../../client/lookup/pull-request-push-target', () => ({
  getPullRequestPushTarget: getPullRequestPushTargetMock
}))

vi.mock('../../client/fetch/get-work-item', () => ({
  getWorkItem: getWorkItemMock
}))

import { resolveGitHubPrStartPoint } from './pr-start-point'
import { reviewHeadRemoteRefComponent } from '../../../../shared/review-head-tracking-ref'

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
    fetchPullRequestHeadRefMock.mockImplementation(async (_remote: string, prNumber: number) =>
      durablePrLocalRef(prNumber)
    )
  })

  it('captures the fork PR head from a dedicated ref, not the shared FETCH_HEAD', async () => {
    getPullRequestPushTargetMock.mockRejectedValue(new Error('head repo is unavailable'))
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    // Concurrent fetches can clobber FETCH_HEAD; the durable Orca ref must remain authoritative.
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
    expect(gitExec).not.toHaveBeenCalledWith(['remote', 'get-url', 'origin'])
    expect(gitExec).not.toHaveBeenCalledWith(['rev-parse', '--verify', 'FETCH_HEAD'])
    expect(result).toEqual({
      baseBranch: 'prheadsha111',
      headSha: 'prheadsha111',
      branchNameOverride: 'feat/onboarding-model-choice-782'
    })
  })

  it('keeps the durable PR head when the head fetch fails but the local ref resolves', async () => {
    // A prior durable fetch can survive transient transport failure.
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
    // Auth/deleted-ref/stale-relay failures must not return a dead or unauthorized cached tip.
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

    expect(result).toMatchObject({
      error: `Failed to fetch refs/pull/1849/head: ${message}`,
      errorCode: 'fetchFailed',
      errorParams: { ref: 'refs/pull/1849/head' },
      errorDetail: message
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
})
