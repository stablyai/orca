import { expect, it } from 'vitest'
import { api } from './work-item-search-test-harness'
import { parseTaskQuery } from '../../shared/task-query'
import { listPullRequestWorkItemPage } from './client/list/work-item-pr-page'

const ownerRepo = { owner: 'fixture', repo: 'repo', host: 'github.com' }
function rows() {
  return Array.from({ length: 300 }, (_, index) => ({
    __typename: 'PullRequest',
    number: 10000 - index,
    title: `PR ${index}`,
    state: 'OPEN',
    url: `https://github.com/fixture/repo/pull/${10000 - index}`,
    updatedAt: '2026-10-01T00:00:00Z',
    author: { login: 'author', name: 'Author', avatarUrl: 'https://avatars.example/author' },
    isDraft: false,
    headRefName: `branch-${index}`,
    baseRefName: 'main',
    headRefOid: `head-${index}`,
    headRepositoryOwner: { login: 'fork-owner' },
    labels: { nodes: [{ name: 'bug' }], pageInfo: { hasNextPage: false } },
    reviewRequests: {
      nodes: [
        {
          requestedReviewer: {
            login: 'reviewer',
            name: 'Reviewer',
            avatarUrl: 'https://avatars.example/reviewer'
          }
        },
        { requestedReviewer: { __typename: 'Team', slug: 'team', name: 'Team' } },
        null
      ],
      pageInfo: { hasNextPage: false }
    }
  }))
}
function page(number: number, noCache = false) {
  return listPullRequestWorkItemPage({
    ownerRepo,
    query: parseTaskQuery('is:pr is:open'),
    limit: 24,
    page: number,
    options: {},
    noCache
  })
}

it('reads only the next PR page while browsing ten numbered pages', async () => {
  api.specialNodes = rows()
  const numbers: number[] = []
  for (let number = 1; number <= 10; number++) {
    numbers.push(...(await page(number)).map((item) => item.number))
  }
  expect(numbers).toEqual(Array.from({ length: 240 }, (_, index) => 10000 - index))
  expect(api.graphqlCalls).toBe(10)
  expect(api.graphqlFields).toBe(10)
  expect(api.calls.some(({ args }) => args[0] === 'pr')).toBe(false)
})
