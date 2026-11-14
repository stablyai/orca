import { expect, it, vi } from 'vitest'
import { found, mocks, read, rpcRead } from './runtime-hosted-pr-snapshot-test-harness'
import { PrForBranch } from '../../../../shared/rpc-contract/github/github-pull-request-params'

it('keeps selected preference optional for old snapshot request parsers', () => {
  const params = { repo: 'repo', branch: 'main', reason: 'swr', selected: true }
  expect(PrForBranch.parse(params)).toMatchObject({ selected: true })
  expect(PrForBranch.omit({ selected: true }).parse(params)).toEqual({
    repo: 'repo',
    branch: 'main',
    reason: 'swr'
  })
  expect(PrForBranch.parse({ repo: 'repo', branch: 'main' })).toEqual({
    repo: 'repo',
    branch: 'main'
  })
})

it('keeps a selected join during an awaited quota probe and its later paused admission', async () => {
  await read('quiet-selected', 'active')
  await vi.advanceTimersByTimeAsync(60_000)
  const confirmation = read('quiet-selected')
  await vi.advanceTimersByTimeAsync(0)
  await confirmation
  const branches = ['ordinary-a', 'ordinary-b', 'ordinary-c']
  await Promise.all(branches.map((branch) => read(branch, 'active')))
  await vi.advanceTimersByTimeAsync(300_000)
  const quotaProbe = Promise.withResolvers<number | null>()
  // ast-grep-ignore: test-no-wall-clock -- The imported runtime fixture installs the fake clock.
  const resetAt = Date.now() + 60_000
  mocks.gate.mockResolvedValue(resetAt).mockReturnValueOnce(quotaProbe.promise)
  const starts: string[] = []
  mocks.resolve.mockImplementation(async ({ branchName }) => {
    starts.push(branchName)
    return found()
  })
  const demand = (branch: string, selected = false) =>
    rpcRead({
      repo: 'repo',
      branch,
      currentHeadOid: 'head-a',
      reason: 'swr',
      acceptRevalidationOnly: true,
      selected
    })
  const first = demand('quiet-selected')
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.gate).toHaveBeenCalled()
  expect(starts).toEqual([])
  const joined = demand('quiet-selected', true)
  const ordinary = branches.map((branch) => demand(branch))
  await vi.advanceTimersByTimeAsync(0)
  quotaProbe.resolve(resetAt)
  await vi.advanceTimersByTimeAsync(25_000)
  await Promise.all([first, joined, ...ordinary])
  mocks.gate.mockResolvedValue(null)
  await vi.advanceTimersByTimeAsync(65_000)
  expect(starts).toEqual(['quiet-selected', 'ordinary-a', 'ordinary-b', 'ordinary-c'])
})

it('uses selected demand only for admission priority, preserving the shared retry interval', async () => {
  await read('retry-policy', 'active')
  await vi.advanceTimersByTimeAsync(60_000)
  mocks.resolve.mockRejectedValueOnce(new Error('offline'))
  // ast-grep-ignore: test-no-wall-clock -- The imported runtime fixture installs the fake clock.
  const requestedAt = Date.now()
  const response = rpcRead({
    repo: 'repo',
    branch: 'retry-policy',
    currentHeadOid: 'head-a',
    reason: 'swr',
    acceptRevalidationOnly: true,
    selected: true
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(await response).toMatchObject({
    kind: 'upstream-error',
    nextAutoRetryAt: requestedAt + 120_000
  })
})
