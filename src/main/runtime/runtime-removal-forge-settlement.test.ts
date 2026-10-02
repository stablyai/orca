import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import type { RuntimeStore } from './runtime-store-contract'

const { events, gitExecFileAsyncMock, getHostedReviewForBranchMock, cleanupPushTargetMock } =
  vi.hoisted(() => {
    const events: string[] = []
    return {
      events,
      gitExecFileAsyncMock: vi.fn(),
      getHostedReviewForBranchMock: vi.fn(),
      cleanupPushTargetMock: vi.fn()
    }
  })

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn(),
  translateWslOutputPaths: (output: string) => output
}))
vi.mock('../git/status', () => ({
  resolveGitDir: vi.fn(),
  runWithGitReadCacheInvalidation: <T>(run: () => Promise<T>) => run()
}))
vi.mock('../source-control/hosted-review', () => ({
  getHostedReviewForBranch: getHostedReviewForBranchMock
}))
vi.mock('../ipc/worktree-remote', () => ({
  cleanupUnusedWorktreePushTargetRemote: cleanupPushTargetMock,
  cleanupUnusedWorktreePushTargetRemoteSsh: cleanupPushTargetMock
}))
vi.mock('../ipc/worktree-change-invalidators', () => ({ runWorktreeChangeInvalidators: vi.fn() }))
vi.mock('../worktree-archive-hook-gate', () => ({
  gateRemovalWhereArchiveHookCannotRun: async () => ({})
}))

import {
  _resetUnansweredReviewHostsForTests,
  FORGE_MERGED_LOOKUP_TIMEOUT_MS
} from '../source-control/forge-merged-branch-cleanup'
import { finishRuntimeLocalWorktreeRemoval } from './runtime-registered-local-worktree-removal'
import { removeRuntimeRegisteredRemoteWorktree } from './runtime-registered-remote-worktree-removal'

const repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0,
  connectionId: null
} satisfies Repo

// Why a linked PR: the lookup must carry the removed worktree's review link.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Removal reads only these three store methods; push-target cleanup is mocked.
const store = {
  getRepos: () => [repo],
  getWorktreeMeta: () => ({ linkedPR: 7 }),
  getAllWorktreeMeta: () => ({})
} as unknown as RuntimeStore

function headOf(name: string): string {
  return name.padEnd(40, '0')
}

function worktree(name: string): GitWorktreeInfo {
  return {
    path: `/repo-${name}`,
    head: headOf(name),
    branch: `refs/heads/feature/${name}`,
    isBare: false,
    isMainWorktree: false
  }
}

function finish(name: string) {
  const finishRemoval = vi.fn()
  const gate = {
    finish: vi.fn(async () => {
      events.push(`gate:${name}`)
    })
  }
  const result = finishRuntimeLocalWorktreeRemoval(
    {
      repo,
      target: { id: `repo-1::/repo-${name}` },
      removedPushTarget: undefined,
      store,
      localOptions: {},
      force: false,
      deleteBranch: true,
      closeWatchers: vi.fn(),
      preserveBranchHead: (removed) => removed ?? {},
      finishRemoval
    },
    worktree(name),
    gate
  )
  return { result, finishRemoval }
}

let platformSpy: MockInstance<() => NodeJS.Platform>

beforeEach(() => {
  _resetUnansweredReviewHostsForTests()
  events.length = 0
  platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    const command = args.join(' ')
    events.push(`git ${command}`)
    if (args[0] === 'branch' && args[1] === '-d') {
      throw new Error(`error: the branch '${args[3]}' is not fully merged`)
    }
    if (args[0] === 'merge-base') {
      // No base holds the head: these branches carry squash-merged commits.
      throw new Error('exit 1')
    }
    return { stdout: '', stderr: '' }
  })
  getHostedReviewForBranchMock.mockReset()
  cleanupPushTargetMock.mockReset()
  cleanupPushTargetMock.mockImplementation(async () => {
    events.push('push-target-cleanup')
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  platformSpy.mockRestore()
})

describe('finishRuntimeLocalWorktreeRemoval branch settlement', () => {
  it('asks the forge after the watcher gate and deletes before the push-target cleanup', async () => {
    getHostedReviewForBranchMock.mockImplementation(async () => {
      events.push('forge-lookup')
      return { provider: 'github', number: 7, state: 'merged', headSha: headOf('a') }
    })

    const { result, finishRemoval } = finish('a')

    await expect(result).resolves.toEqual({})
    const at = (event: string) => events.indexOf(event)
    expect(at('git branch -d -- feature/a')).toBeLessThan(at('gate:a'))
    expect(at('gate:a')).toBeLessThan(at('forge-lookup'))
    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'feature/a',
        linkedGitHubPR: 7,
        currentHeadOid: headOf('a')
      })
    )
    expect(at('forge-lookup')).toBeLessThan(
      at(`git update-ref -d refs/heads/feature/a ${headOf('a')}`)
    )
    expect(at(`git update-ref -d refs/heads/feature/a ${headOf('a')}`)).toBeLessThan(
      at('push-target-cleanup')
    )
    expect(finishRemoval).toHaveBeenCalledWith({}, true, headOf('a'))
  })

  it('keeps the branch for the toast when the forge does not confirm the merge', async () => {
    getHostedReviewForBranchMock.mockResolvedValue({
      provider: 'github',
      number: 7,
      state: 'merged',
      headSha: headOf('z')
    })

    const { result, finishRemoval } = finish('a')

    const kept = { preservedBranch: { branchName: 'feature/a', head: headOf('a') } }
    await expect(result).resolves.toEqual(kept)
    expect(events.some((event) => event.startsWith('git update-ref'))).toBe(false)
    expect(finishRemoval).toHaveBeenCalledWith(kept, true, headOf('a'))
  })

  it('reads no worktree metadata and asks nothing when Git deleted the branch', async () => {
    const readMeta = vi.spyOn(store, 'getWorktreeMeta')
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    const { result } = finish('a')

    await expect(result).resolves.toEqual({})
    expect(readMeta).not.toHaveBeenCalled()
    expect(getHostedReviewForBranchMock).not.toHaveBeenCalled()
  })

  it('finishes the delete and keeps the branch when reading the worktree metadata throws', async () => {
    vi.spyOn(store, 'getWorktreeMeta').mockImplementation(() => {
      throw new Error('store unavailable')
    })

    const { result, finishRemoval } = finish('a')

    const kept = { preservedBranch: { branchName: 'feature/a', head: headOf('a') } }
    await expect(result).resolves.toEqual(kept)
    expect(finishRemoval).toHaveBeenCalledWith(kept, true, headOf('a'))
    expect(events).toContain('push-target-cleanup')
  })

  it('overlaps the forge lookups of a batch, so a hung forge costs one cap, not one per branch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    getHostedReviewForBranchMock.mockImplementation(() => new Promise(() => {}))
    const names = ['a', 'b', 'c', 'd']
    const startedAt = Date.now()

    const removals = names.map((name) => finish(name).result)
    let settled = false
    const all = Promise.all(removals).finally(() => {
      settled = true
    })
    for (let step = 0; !settled && step < names.length * 20 + 20; step += 1) {
      await vi.advanceTimersByTimeAsync(FORGE_MERGED_LOOKUP_TIMEOUT_MS / 10)
    }

    await expect(all).resolves.toEqual(
      names.map((name) => ({
        preservedBranch: { branchName: `feature/${name}`, head: headOf(name) }
      }))
    )
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(FORGE_MERGED_LOOKUP_TIMEOUT_MS)
    expect(elapsed).toBeLessThan(2 * FORGE_MERGED_LOOKUP_TIMEOUT_MS)
    expect(getHostedReviewForBranchMock).toHaveBeenCalledTimes(names.length)
  })
})

describe('removeRuntimeRegisteredRemoteWorktree branch settlement', () => {
  const sshRepo = { ...repo, connectionId: 'conn-1' } satisfies Repo

  function removeRemote(forceDeletePreservedBranch: () => Promise<void>) {
    const provider = {
      removeWorktree: vi.fn(async () => {
        events.push('relay-remove')
        return { preservedBranch: { branchName: 'feature/a', head: headOf('a') } }
      }),
      forceDeletePreservedBranch: vi.fn(async () => {
        events.push('relay-guarded-delete')
        await forceDeletePreservedBranch()
      })
    }
    const finishRemoval = vi.fn()
    const result = removeRuntimeRegisteredRemoteWorktree({
      repo: sshRepo,
      target: { id: 'repo-1::/repo-a', repoId: 'repo-1', path: '/repo-a' },
      registeredWorktree: worktree('a'),
      removedPushTarget: undefined,
      store,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The removal calls only removeWorktree and forceDeletePreservedBranch, both stubbed.
      provider: provider as unknown as SshGitProvider,
      connectionId: 'conn-1',
      runHooks: false,
      allowFailedArchiveHook: false,
      force: false,
      allowUnverifiedPtyStop: false,
      deleteBranch: true,
      acquireWatcherRemoval: async () => ({
        finish: async () => {
          events.push('gate')
        }
      }),
      stopPtys: async () => {},
      deleteHistory: async () => {},
      preserveBranchHead: (removed) => removed ?? {},
      finishRemoval
    })
    return { result, finishRemoval, provider }
  }

  it('deletes a merged SSH branch through the relay before the push-target cleanup', async () => {
    getHostedReviewForBranchMock.mockImplementation(async (input: { executionHostId: string }) => {
      events.push(`forge-lookup:${input.executionHostId}`)
      return { provider: 'github', number: 7, state: 'merged', headSha: headOf('a') }
    })

    const { result, finishRemoval, provider } = removeRemote(async () => {})

    await expect(result).resolves.toEqual({})
    expect(provider.forceDeletePreservedBranch).toHaveBeenCalledWith(
      '/repo',
      'feature/a',
      headOf('a')
    )
    expect(events).toEqual([
      'relay-remove',
      'gate',
      'forge-lookup:ssh:conn-1',
      'relay-guarded-delete',
      'push-target-cleanup'
    ])
    expect(finishRemoval).toHaveBeenCalledWith({})
  })

  it('waits on a hung review host once across serial removals, not once per workspace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    getHostedReviewForBranchMock.mockImplementation(() => new Promise(() => {}))
    const startedAt = Date.now()
    const kept = { preservedBranch: { branchName: 'feature/a', head: headOf('a') } }

    // Like removing an SSH host's workspaces: each removal starts after the previous one returns.
    for (let removal = 0; removal < 3; removal += 1) {
      const { result } = removeRemote(async () => {})
      let settled = false
      void result.finally(() => {
        settled = true
      })
      for (let step = 0; !settled && step < 20; step += 1) {
        await vi.advanceTimersByTimeAsync(FORGE_MERGED_LOOKUP_TIMEOUT_MS / 10)
      }
      await expect(result).resolves.toEqual(kept)
    }

    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(FORGE_MERGED_LOOKUP_TIMEOUT_MS)
    expect(elapsed).toBeLessThan(2 * FORGE_MERGED_LOOKUP_TIMEOUT_MS)
    expect(getHostedReviewForBranchMock).toHaveBeenCalledTimes(1)
  })

  it('finishes the SSH delete and keeps the branch when reading the worktree metadata throws', async () => {
    vi.spyOn(store, 'getWorktreeMeta').mockImplementation(() => {
      throw new Error('store unavailable')
    })

    const { result, provider } = removeRemote(async () => {})

    await expect(result).resolves.toEqual({
      preservedBranch: { branchName: 'feature/a', head: headOf('a') }
    })
    expect(provider.forceDeletePreservedBranch).not.toHaveBeenCalled()
    expect(events).toContain('push-target-cleanup')
  })

  it('keeps the SSH branch when an old relay lacks the guarded delete', async () => {
    getHostedReviewForBranchMock.mockResolvedValue({
      provider: 'github',
      number: 7,
      state: 'merged',
      headSha: headOf('a')
    })

    const { result } = removeRemote(async () => {
      throw new Error('This SSH host is running an older Orca relay')
    })

    await expect(result).resolves.toEqual({
      preservedBranch: { branchName: 'feature/a', head: headOf('a') }
    })
  })
})
