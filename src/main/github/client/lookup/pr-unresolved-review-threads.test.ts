import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  countUnresolvedReviewThreadNodes,
  fetchUnresolvedReviewCommentCount
} from './pr-unresolved-review-threads'

const thread = (isResolved: boolean, login: string, typename = 'User') => ({
  isResolved,
  comments: { nodes: [{ author: { __typename: typename, login } }] }
})

describe('countUnresolvedReviewThreadNodes', () => {
  it('counts unresolved human threads and skips resolved and bot ones', () => {
    expect(
      countUnresolvedReviewThreadNodes([
        thread(false, 'alice'),
        thread(true, 'alice'),
        thread(false, 'github-actions', 'Bot'),
        thread(false, 'coderabbitai'),
        null,
        { isResolved: false }
      ])
    ).toBe(2)
  })
})

const { exec, guard, spend } = vi.hoisted(() => ({
  exec: vi.fn(),
  guard: vi.fn(),
  spend: vi.fn()
}))
vi.mock('../../gh-utils', () => ({ ghExecFileAsync: exec }))
vi.mock('../../rate-limit', () => ({
  repositoryRateLimitGuard: guard,
  noteRepositoryRateLimitSpend: spend
}))

const ownerRepo = { owner: 'org', repo: 'repo', host: 'github.example.com' }
const options = { cwd: '/workspace' }
const data = {
  number: 12,
  title: '',
  state: 'OPEN',
  url: '',
  statusCheckRollup: [],
  updatedAt: '',
  mergeable: 'UNKNOWN'
}
const page = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
  stdout: JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } }
        }
      }
    }
  })
})

describe('fetchUnresolvedReviewCommentCount', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    guard.mockReturnValue({ blocked: false })
  })

  it('counts page two and guards/accounts for each host-scoped request', async () => {
    exec
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 100 }, () => thread(true, 'alice')),
          true,
          'next'
        )
      )
      .mockResolvedValueOnce(page([thread(false, 'bob')]))
    expect(await fetchUnresolvedReviewCommentCount(ownerRepo, data, options)).toBe(1)
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec.mock.calls[1][0]).toContain('cursor=next')
    expect(exec.mock.calls[1][1]).toMatchObject(options)
    expect(guard).toHaveBeenCalledTimes(2)
    expect(guard).toHaveBeenLastCalledWith(ownerRepo, 'graphql', options)
    expect(spend).toHaveBeenCalledTimes(2)
    expect(spend).toHaveBeenLastCalledWith(ownerRepo, 'graphql', 1, options)
  })

  it('does not publish a partial count when the next page is blocked', async () => {
    exec.mockResolvedValueOnce(page([thread(false, 'alice')], true, 'next'))
    guard.mockReturnValueOnce({ blocked: false }).mockReturnValueOnce({ blocked: true })
    expect(await fetchUnresolvedReviewCommentCount(ownerRepo, data, options)).toBeUndefined()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(spend).toHaveBeenCalledTimes(1)
  })

  it('does not publish a partial count when a later request fails', async () => {
    exec
      .mockResolvedValueOnce(page([thread(false, 'alice')], true, 'next'))
      .mockRejectedValueOnce(new Error('offline'))
    expect(await fetchUnresolvedReviewCommentCount(ownerRepo, data, options)).toBeUndefined()
  })

  it('rejects incomplete pagination metadata', async () => {
    exec.mockResolvedValueOnce(page([thread(false, 'alice')], true))
    expect(await fetchUnresolvedReviewCommentCount(ownerRepo, data, options)).toBeUndefined()
  })
})
