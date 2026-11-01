import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  HOSTED_REVIEW_LOOKUP_DEADLINE_MS,
  NO_REVIEW_REFRESH_INTERVAL_MS
} from './hosted-review-refresh-pacing'
import { githubRepoContext } from '../github/github-repository-identity'
import type { Repo } from '../../shared/repo-types'
import { installGitHubProjectAccounts } from '../github/github-project-account'
import { __resetHostedReviewBranchCacheForTests } from './hosted-review-branch-cache'
import { getHostedReviewForBranch } from './hosted-review'

const { read, detect, probe } = vi.hoisted(() => ({
  read: vi.fn(),
  detect: vi.fn(),
  probe: vi.fn()
}))
vi.mock('../git/remote-url-probe', () => ({ assertRemoteUrlReadable: probe }))
vi.mock('./forge-provider', () => ({ getForgeProviderForRepository: detect }))
let release: () => void
let repo: Repo
beforeEach(() => {
  __resetHostedReviewBranchCacheForTests()
  probe.mockReset()
  read.mockReset()
  detect.mockReset().mockResolvedValue({ id: 'github', getReviewForBranch: read })
  repo = {
    id: 'repo',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000000',
    addedAt: 0,
    ghAccount: { host: 'github.com', user: 'Alice' }
  }
  release = installGitHubProjectAccounts({ getRepos: () => [repo] })
})
afterEach(() => {
  release()
  vi.useRealTimers()
  __resetHostedReviewBranchCacheForTests()
})

it('does not reuse a negative review result after the saved account changes or clears', async () => {
  read.mockResolvedValue(null)
  const input = { repoPath: '/repo', executionHostId: 'local', branch: 'feature' } as const
  await getHostedReviewForBranch(input)
  await getHostedReviewForBranch(input)
  expect(read).toHaveBeenCalledTimes(1)
  expect(read.mock.calls[0][0].localGitExecOptions.ghAccount.user).toBe('Alice')
  repo = { ...repo, ghAccount: { host: 'github.com', user: 'Bob' } }
  await getHostedReviewForBranch(input)
  expect(read).toHaveBeenCalledTimes(2)
  expect(read.mock.calls[1][0].localGitExecOptions.ghAccount.user).toBe('Bob')
  repo = { ...repo, ghAccount: undefined }
  await getHostedReviewForBranch(input)
  expect(read).toHaveBeenCalledTimes(3)
  expect(read.mock.calls[2][0].localGitExecOptions.ghAccount).toBeUndefined()
})

it('leaves other providers outside GitHub account selection', async () => {
  detect.mockResolvedValue({ id: 'gitlab', getReviewForBranch: read })
  read.mockResolvedValue(null)
  await getHostedReviewForBranch({ repoPath: '/repo', executionHostId: 'local', branch: 'feature' })
  expect(read.mock.calls[0][0].localGitExecOptions).toBeUndefined()
})

it.each(['github', 'gitlab'] as const)(
  'keeps %s discovery inside cache, failure/backoff and total deadline',
  async (id) => {
    vi.useFakeTimers()
    const review = { provider: id, title: 'Last good' }
    detect.mockResolvedValue({ id, getReviewForBranch: read })
    read.mockResolvedValue(review)
    const localGitExecOptions = { ghAccount: repo.ghAccount, admissionTier: 'background' } as const
    const input = {
      repoPath: '/repo',
      executionHostId: 'local',
      branch: 'feature',
      localGitExecOptions
    } as const
    await expect(getHostedReviewForBranch(input)).resolves.toEqual(review)
    expect(detect.mock.calls[0][0]).toEqual({
      repoPath: input.repoPath,
      executionHostId: input.executionHostId,
      localGitExecOptions
    })
    expect(read.mock.calls[0][0]).toMatchObject({ branch: 'feature', localGitExecOptions })
    detect.mockResolvedValue(null)
    probe.mockRejectedValue(new Error('Remote discovery unavailable'))
    // Same fresh hit as the old path: no discovery/probe, regardless of new detector outcome.
    await expect(getHostedReviewForBranch(input)).resolves.toEqual(review)
    expect(detect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(NO_REVIEW_REFRESH_INTERVAL_MS)
    await expect(getHostedReviewForBranch(input)).resolves.toEqual(review)
    expect(detect).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenCalledTimes(1)
    await expect(getHostedReviewForBranch(input)).resolves.toEqual(review)
    expect(detect).toHaveBeenCalledTimes(2)

    // New branch, unsettled discovery: coalescing and deadline enclose discovery itself.
    detect.mockImplementation(() => new Promise(() => {}))
    const fresh = { ...input, branch: 'new' }
    const first = getHostedReviewForBranch(fresh).catch((error: Error) => error.message)
    const second = getHostedReviewForBranch(fresh).catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
    expect(await first).toContain('timed out')
    expect(await second).toContain('timed out')
    expect(detect).toHaveBeenCalledTimes(3)
    await expect(getHostedReviewForBranch(fresh)).rejects.toThrow('backing off')
    expect(detect).toHaveBeenCalledTimes(3)
  }
)

it('pins detached provider work through late publication, while independent operations reselect', async () => {
  vi.useFakeTimers()
  let resume: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  let entered: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const observed: string[] = []
  read.mockImplementation(async (input) => {
    entered()
    await gate
    const selected = githubRepoContext(input.repoPath, null, input.localGitExecOptions).ghAccount
      ?.user
    observed.push(selected ?? 'ambient')
    return { title: selected, state: 'open' }
  })
  const input = { repoPath: '/repo', executionHostId: 'local', branch: 'feature' } as const
  const pending = getHostedReviewForBranch(input).catch((error: Error) => error.message)
  await started
  await vi.advanceTimersByTimeAsync(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
  expect(await pending).toContain('timed out')
  repo = { ...repo, ghAccount: { host: 'github.com', user: 'Bob' } }
  resume()
  await vi.advanceTimersByTimeAsync(0)
  await expect(getHostedReviewForBranch(input)).resolves.toMatchObject({ title: 'Bob' })
  repo = { ...repo, ghAccount: { host: 'github.com', user: 'Alice' } }
  await expect(getHostedReviewForBranch(input)).resolves.toMatchObject({ title: 'Alice' })
  expect(observed).toEqual(['Alice', 'Bob'])
  expect(read).toHaveBeenCalledTimes(2)
})

// A polling batch makes N independent requests; each may scan the live catalog once.
it.each(['root', 'warm', 'cold'] as const)(
  'bounds %s ownership work per refresh at N and 10N',
  async (mode) => {
    const measurements: number[] = []
    for (const count of [10, 100]) {
      let visits = 0
      const repos = Array.from({ length: count }, (_, i) => ({
        ...repo,
        get id() {
          visits++
          return `r${i}`
        },
        path: `/r${i}`,
        ghAccount: { host: 'github.com', user: i === count - 1 ? 'Bob' : 'Alice' }
      }))
      const projects = repos.map((entry) => ({
        id: entry.id,
        displayName: 'Project',
        badgeColor: '#000000',
        createdAt: 0,
        updatedAt: 0,
        get sourceRepoIds() {
          visits++
          return [entry.id]
        }
      }))
      const children = Array.from({ length: count }, (_, i) => ({
        get repoId() {
          visits++
          return `r${count - 1}`
        },
        get path() {
          visits++
          return `/children/${i}`
        }
      }))
      release = installGitHubProjectAccounts(
        {
          getRepos: () => repos,
          getProjects: () => projects,
          getSettings: () => ({}),
          getAllWorktreeMetaForHost: () =>
            mode === 'cold'
              ? Object.fromEntries(children.map((child) => [`${child.repoId}::${child.path}`, {}]))
              : {}
        },
        () => (mode === 'warm' ? children : [])
      )
      __resetHostedReviewBranchCacheForTests()
      read.mockImplementation(async (input) => ({
        title: githubRepoContext(input.repoPath, null, input.localGitExecOptions).ghAccount?.user
      }))
      visits = 0
      for (let i = 0; i < count; i++) {
        const selected = await getHostedReviewForBranch({
          repoPath: mode === 'root' ? `/r${i}` : `/children/${i}`,
          executionHostId: 'local',
          branch: 'feature'
        })
        expect(selected?.title).toBe(mode === 'root' && i !== count - 1 ? 'Alice' : 'Bob')
      }
      measurements.push(visits)
      // O(N) live catalog/ownership work per independent request, not nested project scans.
      expect(visits).toBeLessThanOrEqual(16 * count * count)
      release()
    }
    expect(measurements[1]).toBeLessThanOrEqual(110 * measurements[0])
  }
)
