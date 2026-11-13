import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { setPRAutoRefreshCadence } from '../../../../shared/review-refresh-policy'
import {
  _prChecksResultCountForTests,
  _resetPacedPRChecksForTests
} from '../../../github/client/check/pr-checks-last-outcome'
import {
  __resetHostedReviewScopeGenerationsForTests,
  bumpScopeGeneration,
  hostedReviewRepoScope
} from '../../../source-control/hosted-review-scope-generations'

// Only the provider is faked: each gh call waits for the test to answer it with a check name.
type ProviderCall = { answer: (name: string) => void; fail: () => void }
const provider = vi.hoisted(() => {
  const calls: ProviderCall[] = []
  return { calls, offline: false }
})
// Command slots only bound how many provider commands run at once; the reads under test are live
// either way, so each gh call here reaches the fake provider as soon as it starts.
vi.mock('../../../github/execution/github-operation-slots', () => ({
  acquire: async () => {},
  release: () => {}
}))
vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: () =>
    new Promise((resolve, reject) =>
      provider.offline
        ? reject(new Error('offline'))
        : provider.calls.push({
            answer: (name) =>
              resolve({
                stdout: JSON.stringify({
                  data: {
                    repository: {
                      pullRequest: {
                        headRefOid: 'head-a',
                        commits: {
                          nodes: [
                            {
                              commit: {
                                statusCheckRollup: {
                                  contexts: {
                                    nodes: [
                                      {
                                        __typename: 'CheckRun',
                                        name,
                                        status: 'COMPLETED',
                                        conclusion: 'SUCCESS'
                                      }
                                    ]
                                  }
                                }
                              }
                            }
                          ]
                        }
                      }
                    }
                  }
                }),
                stderr: ''
              }),
            fail: () => reject(new Error('offline'))
          })
    )
}))
vi.mock('../../../github/repositories/github-api-repository', () => ({
  resolveGitHubRepoExecution: async () => ({
    ownerRepo: { owner: 'acme', repo: 'repo' },
    ghOptions: {}
  })
}))
vi.mock('../../../github/client/lookup/pr-lookup-rate-limit', () => ({
  assertRateLimitBudget: async () => {}
}))
vi.mock('../../../github/api/rate-limit', () => ({ noteRepositoryRateLimitSpend: () => {} }))

import { RuntimeGitHubReviewQueryCommands } from './runtime-github-review-query-commands'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0,
  kind: 'git'
}
const commands = new RuntimeGitHubReviewQueryCommands({
  resolveRepo: async () => repo,
  getLocalGitArgs: () => []
})
const prRepo = { owner: 'acme', repo: 'repo' }

const read = (options: Parameters<typeof commands.getRepoPRChecks>[4] = {}, head = 'head-a') =>
  commands.getRepoPRChecks(repo.id, 7, head, prRepo, options)
const timed = (head?: string) => read({ reason: 'swr' }, head)
const manual = () => read({ noCache: true, userRefresh: true })
const names = async (checks: ReturnType<typeof read>) => (await checks).map((check) => check.name)

async function answerNext(name: string): Promise<void> {
  await vi.waitFor(() => expect(provider.calls.length).toBeGreaterThan(0))
  provider.calls.shift()!.answer(name)
}

describe('github.prChecks: one checks result per PR head, read on the host’s cadence', () => {
  beforeEach(() => {
    provider.calls = []
    provider.offline = false
    _resetPacedPRChecksForTests()
    __resetHostedReviewScopeGenerationsForTests()
  })
  afterEach(() => {
    // Settle whatever a failed case left running, so no read carries into the next case.
    provider.offline = true
    for (const call of provider.calls.splice(0)) {
      call.fail()
    }
    setPRAutoRefreshCadence('default')
    vi.useRealTimers()
  })

  it('reads the provider for every timed read by default, and answers from the last read while off', async () => {
    const first = timed()
    await answerNext('first')
    await first
    const again = timed()
    await answerNext('second')
    expect(await names(again)).toEqual(['second'])

    setPRAutoRefreshCadence('off')
    expect(await names(timed())).toEqual(['second'])
    expect(provider.calls).toHaveLength(0)
    // Another head is another resource.
    const otherHead = timed('head-b')
    await answerNext('other head')
    expect(await names(otherHead)).toEqual(['other head'])
  })

  it('while off, a manual read still reaches the provider and becomes every later timed answer; a failed one changes nothing', async () => {
    setPRAutoRefreshCadence('off')
    const first = timed()
    await answerNext('timed')
    await first
    const refreshed = manual()
    await answerNext('manual')
    expect(await names(refreshed)).toEqual(['manual'])
    expect(await names(timed())).toEqual(['manual'])

    // Every provider path (GraphQL, REST and gh pr checks) fails.
    provider.offline = true
    await expect(manual()).rejects.toThrow()
    provider.offline = false
    expect(await names(timed())).toEqual(['manual'])
  })

  it('a read that joins an older timed read never hands back or keeps that older answer over a newer manual one', async () => {
    setPRAutoRefreshCadence('off')
    const olderTimed = timed()
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    const refreshed = manual()
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2))
    provider.calls.pop()!.answer('manual')
    expect(await names(refreshed)).toEqual(['manual'])

    const joined = read()
    provider.calls.shift()!.answer('older timed')
    expect(await names(joined)).toEqual(['manual'])
    expect(await names(olderTimed)).toEqual(['manual'])
    expect(await names(timed())).toEqual(['manual'])
    expect(provider.calls).toHaveLength(0)
  })

  it('keeps that newer manual answer authoritative while the older read lives through cache pressure', async () => {
    setPRAutoRefreshCadence('off')
    const olderTimed = timed()
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    const refreshed = manual()
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2))
    provider.calls.pop()!.answer('manual')
    expect(await names(refreshed)).toEqual(['manual'])
    const joined = read()
    // 256 other PR heads complete while the older read is still out, filling the completed bound.
    for (let head = 0; head < 256; head += 1) {
      const other = read({}, `other-head-${head}`)
      await vi.waitFor(() => expect(provider.calls).toHaveLength(2), { interval: 1 })
      provider.calls.pop()!.answer(`other ${head}`)
      expect(await names(other)).toEqual([`other ${head}`])
    }
    provider.calls.shift()!.answer('older timed')
    expect(await names(joined)).toEqual(['manual'])
    expect(await names(olderTimed)).toEqual(['manual'])
    expect(await names(timed())).toEqual(['manual'])
    expect(provider.calls).toHaveLength(0)
    expect(_prChecksResultCountForTests()).toEqual({ completed: 256, running: 0 })
  })

  it.each(['answers', 'fails'] as const)(
    'a read replaced by a user refresh that ended long ago %s with the newest answer accepted since, even after eviction',
    async (outcome) => {
      const replaced = timed()
      const joined = read()
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
      // A user refresh of the same read replaces the running one instead of joining it, and ends.
      const refreshed = read({ userRefresh: true })
      await vi.waitFor(() => expect(provider.calls).toHaveLength(2))
      provider.calls.pop()!.answer('refreshed')
      expect(await names(refreshed)).toEqual(['refreshed'])
      // A later manual read of the other intent starts and ends while the replaced read still runs.
      const manualRead = manual()
      await vi.waitFor(() => expect(provider.calls).toHaveLength(2))
      provider.calls.pop()!.answer('manual')
      expect(await names(manualRead)).toEqual(['manual'])
      for (let head = 0; head < 256; head += 1) {
        const other = read({}, `evicting-head-${head}`)
        await vi.waitFor(() => expect(provider.calls).toHaveLength(2), { interval: 1 })
        provider.calls.pop()!.answer(`other ${head}`)
        await other
      }
      if (outcome === 'answers') {
        provider.calls.shift()!.answer('replaced')
      } else {
        provider.offline = true
        provider.calls.shift()!.fail()
      }
      expect(await names(replaced)).toEqual(['manual'])
      expect(await names(joined)).toEqual(['manual'])
      expect(provider.calls).toHaveLength(0)
      expect(_prChecksResultCountForTests()).toEqual({ completed: 256, running: 0 })
    }
  )

  it('a replaced read answers with its own result when its successor fails and nothing newer was accepted', async () => {
    const replaced = timed()
    const joined = read()
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    const refreshed = read({ userRefresh: true })
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2))
    provider.calls.shift()!.answer('replaced')
    provider.offline = true
    provider.calls.shift()!.fail()
    await expect(refreshed).rejects.toThrow()
    expect(await names(replaced)).toEqual(['replaced'])
    expect(await names(joined)).toEqual(['replaced'])
    expect(_prChecksResultCountForTests().running).toBe(0)
  })

  it('keeps at most 256 completed answers while every one of them is being read again, and a new manual read still works', async () => {
    const heads = Array.from({ length: 256 }, (_, head) => `cached-head-${head}`)
    for (const head of heads) {
      const cached = read({}, head)
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1), { interval: 1 })
      provider.calls.shift()!.answer(head)
      await cached
    }
    const rereads = heads.map((head) => read({ noCache: true }, head))
    await vi.waitFor(() => expect(provider.calls).toHaveLength(256), { interval: 1 })
    const fresh = read({ noCache: true, userRefresh: true }, 'new-head')
    await vi.waitFor(() => expect(provider.calls).toHaveLength(257), { interval: 1 })
    provider.calls.pop()!.answer('new')
    expect(await names(fresh)).toEqual(['new'])
    expect(_prChecksResultCountForTests()).toEqual({ completed: 256, running: 256 })

    // Failed reads end their running state as well.
    provider.offline = true
    for (const call of provider.calls.splice(0)) {
      call.fail()
    }
    await Promise.allSettled(rereads)
    expect(_prChecksResultCountForTests()).toEqual({ completed: 256, running: 0 })
  })

  it('a read after a PR mutation starts its own provider read instead of joining one from before it', async () => {
    setPRAutoRefreshCadence('off')
    const beforeMutation = timed()
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    bumpScopeGeneration(hostedReviewRepoScope(repo.path, 'local'))
    const afterMutation = read()
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2))
    provider.calls.shift()!.answer('before mutation')
    await beforeMutation
    provider.calls.shift()!.answer('after mutation')
    expect(await names(afterMutation)).toEqual(['after mutation'])
    expect(await names(timed())).toEqual(['after mutation'])
  })
})
