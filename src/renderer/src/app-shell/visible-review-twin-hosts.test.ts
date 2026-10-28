import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { GitHubPRRefreshCandidate } from '../../../shared/github/pull-request-refresh-types'
import type { HostedReviewInfo } from '../../../shared/hosted-review'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from '../store/slices/github-slice-test-harness'
import { getVisibleHostedReviewRefreshTargets } from '../store/github/visible-hosted-review-refresh-targets'
import {
  buildPRRefreshCandidate,
  findWorktreeById,
  isStaleExactLinkedPRLookup
} from '../store/github/worktree-refresh'
import {
  createVisibleReviewReportIdentitySelector,
  visibleReviewWorktreeIdsForState
} from './use-visible-review-refresh-reporting'

const reportVisible =
  vi.fn<
    (args: { candidates: GitHubPRRefreshCandidate[]; generation: number }) => Promise<boolean>
  >()
const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '',
  addedAt: 1,
  gitRemoteIdentity: {
    canonicalKey: 'github.com/team/repo',
    remoteName: 'origin',
    remoteUrl: 'https://github.com/team/repo.git'
  }
}
const card = makePRRefreshWorktree({ id: 'card', hostId: 'local', linkedPR: 11 })

function twins(remoteHost: ExecutionHostId, provider = 'github') {
  const store = createTestStore()
  const owner = {
    ...repo,
    gitRemoteIdentity: {
      canonicalKey: `${provider}.com/team/repo`,
      remoteName: 'origin',
      remoteUrl: `https://${provider}.com/team/repo.git`
    }
  }
  store.setState({
    settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'elsewhere' }),
    repos: [
      owner,
      {
        ...owner,
        executionHostId: remoteHost,
        ...(remoteHost === 'ssh:builder' ? { connectionId: 'builder' } : {})
      }
    ],
    worktreesByRepo: {
      'repo-1': [card, { ...card, hostId: remoteHost, head: 'remote-head', linkedPR: 22 }]
    },
    detectedWorktreesByRepo: {},
    activeWorktreeId: 'another-workspace',
    activeWorkspaceExecutionHostId: 'local',
    rightSidebarOpen: false,
    visibleReviewCardWorktreeIds: [card.id],
    visibleWorkspaceHostIds: null,
    workspaceHostScope: 'all',
    sshConnectionStates: new Map([
      ['builder', { targetId: 'builder', status: 'connected', error: null, reconnectAttempt: 0 }]
    ])
  })
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  reportVisible.mockResolvedValue(true)
  vi.stubGlobal('window', {
    api: { ...mockApi, gh: { ...mockApi.gh, reportVisiblePRRefreshCandidates: reportVisible } }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('visible unselected workspace twins', () => {
  it.each([
    ['ssh:builder', 'all'],
    ['ssh:builder', 'local'],
    ['ssh:builder', 'remote'],
    ['runtime:server', 'all'],
    ['runtime:server', 'local'],
    ['runtime:server', 'remote']
  ] as const)('reports GitHub owners on %s with the %s host filter', async (hostId, filter) => {
    const store = twins(hostId)
    const hosts: ExecutionHostId[] =
      filter === 'all' ? ['local', hostId] : [filter === 'local' ? 'local' : hostId]
    store.setState({ visibleWorkspaceHostIds: hosts })

    const ids = visibleReviewWorktreeIdsForState(store.getState())
    expect(ids).toEqual([card.id])
    await store.getState().reportVisibleGitHubPRRefreshCandidates(ids, 123)

    const localHosts = hosts.filter((host) => !host.startsWith('runtime:'))
    expect(reportVisible).toHaveBeenCalledExactlyOnceWith({
      generation: 123,
      candidates: localHosts.map((host) =>
        expect.objectContaining({
          worktreeId: card.id,
          cacheKey: `${host === 'local' ? '' : `${host}::`}repo-1::${card.branch}`,
          linkedPRNumber: host === 'local' ? 11 : 22,
          isSelected: false
        })
      )
    })
    const targets = getVisibleHostedReviewRefreshTargets(store.getState(), store.getState)
    expect(targets.map((target) => target.key)).toEqual(
      hosts
        .filter((host) => host.startsWith('runtime:'))
        .map((host) => `${host}::repo-1::${card.branch}`)
    )
    expect(targets.every((target) => !target.selected)).toBe(true)
    runtimeEnvironmentCall.mockResolvedValue({ id: 'pr', ok: true, result: makePR({ number: 22 }) })
    for (const target of targets) {
      expect(await target.refresh()).toBe(true)
      expect(store.getState().prCache[target.key]?.data?.number).toBe(22)
    }
  })

  it('refreshes provider-neutral twins and tracks hidden-owner and visible-owner changes', async () => {
    const store = twins('ssh:builder', 'gitlab')
    store.setState({
      worktreesByRepo: {
        'repo-1': store.getState().worktreesByRepo['repo-1'].map((worktree) => ({
          ...worktree,
          linkedPR: null,
          linkedGitLabMR: worktree.hostId === 'local' ? 11 : 22
        }))
      }
    })
    const select = createVisibleReviewReportIdentitySelector()
    const all = select(store.getState())
    await store
      .getState()
      .reportVisibleGitHubPRRefreshCandidates(visibleReviewWorktreeIdsForState(store.getState()), 1)
    const targets = getVisibleHostedReviewRefreshTargets(store.getState(), store.getState)
    expect(targets.map((target) => target.key)).toEqual([
      `local::repo-1::${card.branch}`,
      `ssh:builder::repo-1::${card.branch}`
    ])
    const review: HostedReviewInfo = {
      provider: 'gitlab',
      number: 11,
      title: 'Review',
      url: 'https://gitlab.com/team/repo/-/merge_requests/11',
      state: 'open',
      status: 'success',
      updatedAt: '',
      mergeable: 'MERGEABLE'
    }
    mockApi.hostedReview.forBranch
      .mockResolvedValueOnce(review)
      .mockResolvedValueOnce({ ...review, number: 22 })
    for (const target of targets) {
      expect(await target.refresh()).toBe(true)
      expect(store.getState().hostedReviewCache[target.key]?.data).toMatchObject({
        provider: 'gitlab',
        number: target.key.startsWith('local::') ? 11 : 22
      })
    }
    const beforeFilter = select(store.getState())
    store.setState({ workspaceHostScope: 'local' })
    const local = select(store.getState())
    expect(local).not.toBe(all)
    expect(local).not.toBe(beforeFilter)
    const [localCard, remoteCard] = store.getState().worktreesByRepo['repo-1']
    store.setState({ worktreesByRepo: { 'repo-1': [localCard, { ...remoteCard, head: 'new' }] } })
    expect(select(store.getState())).toBe(local)
    store.setState({ workspaceHostScope: 'ssh:builder' })
    const remote = select(store.getState())
    expect(remote).not.toBe(local)
    store.setState({ worktreesByRepo: { 'repo-1': [localCard, { ...remoteCard, head: 'newer' }] } })
    expect(select(store.getState())).not.toBe(remote)
    const ids = visibleReviewWorktreeIdsForState(store.getState())
    expect(ids).toEqual([card.id])
    await store.getState().reportVisibleGitHubPRRefreshCandidates(ids, 2)
    expect(
      getVisibleHostedReviewRefreshTargets(store.getState(), store.getState).map((t) => t.key)
    ).toEqual([`ssh:builder::repo-1::${card.branch}`])
  })

  it('marks only the selected host when both twins are visible', async () => {
    const store = twins('ssh:builder')
    store.setState({ activeWorktreeId: card.id, activeWorkspaceExecutionHostId: 'ssh:builder' })
    await store
      .getState()
      .reportVisibleGitHubPRRefreshCandidates(visibleReviewWorktreeIdsForState(store.getState()), 1)
    expect(
      reportVisible.mock.calls[0][0].candidates.map((candidate) => candidate.isSelected)
    ).toEqual([false, true])
  })

  it('discovers each host using its own remote provider identity', async () => {
    const store = twins('runtime:server', 'gitlab')
    const [local, remote] = store.getState().repos
    store.setState({
      repos: [local, { ...remote, gitRemoteIdentity: repo.gitRemoteIdentity }],
      worktreesByRepo: {
        'repo-1': store.getState().worktreesByRepo['repo-1'].map((worktree) => ({
          ...worktree,
          linkedPR: null
        }))
      }
    })
    await store
      .getState()
      .reportVisibleGitHubPRRefreshCandidates(visibleReviewWorktreeIdsForState(store.getState()), 1)
    expect(reportVisible.mock.calls[0][0].candidates).toEqual([])
    const targets = getVisibleHostedReviewRefreshTargets(store.getState(), store.getState)
    expect(targets).toHaveLength(2)
    runtimeEnvironmentCall.mockResolvedValue({ id: 'pr', ok: true, result: makePR({ number: 22 }) })
    expect(await targets.find((target) => target.key.startsWith('runtime:'))?.refresh()).toBe(true)
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'github.prForBranch',
        selector: 'server'
      })
    )
  })
})

it('retains unstamped local linked PR results when the repository has multiple hosts', async () => {
  const store = twins('runtime:server')
  const unstamped = { ...card, hostId: undefined }
  store.setState({ worktreesByRepo: { 'repo-1': [unstamped] } })
  expect(findWorktreeById(store.getState(), card.id, 'local')).toBe(unstamped)
  expect(findWorktreeById(store.getState(), card.id, 'runtime:server')).toBeNull()
  expect(isStaleExactLinkedPRLookup(store.getState(), card.id, 11, 'local')).toBe(false)
  expect(buildPRRefreshCandidate(store.getState(), unstamped)).toMatchObject({
    repoPath: repo.path,
    cacheKey: `repo-1::${card.branch}`,
    linkedPRNumber: 11
  })
  mockApi.gh.refreshPRNow.mockResolvedValue({
    kind: 'found',
    pr: makePR({ number: 11 }),
    fetchedAt: 123
  })
  const result = await store.getState().fetchPRForBranch(repo.path, card.branch, {
    repoId: repo.id,
    repoOwnerExecutionHostId: 'local',
    worktreeId: card.id,
    linkedPRNumber: 11
  })
  expect(result?.number).toBe(11)
  expect(store.getState().prCache[`repo-1::${card.branch}`]?.data?.number).toBe(11)
  expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
})
