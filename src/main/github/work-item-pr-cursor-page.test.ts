import { expect, it, vi } from 'vitest'
import { api, capture, sourceContext } from './work-item-search-test-harness'
import { parseTaskQuery } from '../../shared/task-query'
import { listPullRequestWorkItemPage } from './client/list/work-item-pr-page'
import { listWorkItems } from './client/list/list-work-items'
import { searchWorkItemPage } from './client/list/work-item-search-page'
import { requestWorkItemSearch } from './client/list/work-item-search-batch'

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
        {
          requestedReviewer: {
            __typename: 'Team',
            slug: 'team',
            name: 'Team',
            organization: { login: 'fixture-org' }
          }
        },
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

it('keeps content uncached and preserves rich rows through the production listing', async () => {
  api.specialNodes = rows()
  const first = await listWorkItems('fixture/repo', 24, 'is:pr is:open')
  expect(first.items[0]).toMatchObject({
    title: 'PR 0',
    labels: ['bug'],
    branchName: 'branch-0',
    baseRefName: 'main',
    headSha: 'head-0',
    isCrossRepository: true,
    author: 'author',
    reviewRequests: [
      { login: 'reviewer', name: 'Reviewer' },
      { login: 'fixture-org/team', name: 'Team', avatarUrl: '' }
    ]
  })
  api.specialNodes[0].title = 'New title'
  expect((await page(1))[0].title).toBe('New title')
  expect(
    api.calls.filter(({ args }) => args.some((arg) => arg.includes('r0: search(')))
  ).toHaveLength(2)
})

it('starts without saved cursors on a manual refresh of a later page', async () => {
  api.specialNodes = rows()
  await page(1)
  await page(2)
  const before = api.graphqlCalls
  expect((await page(2, true))[0].number).toBe(9976)
  expect(api.graphqlCalls - before).toBe(1)
  expect(api.calls.at(-1)?.args.join(' ')).toContain('first: 48')
  expect(api.calls.at(-1)?.args.join(' ')).not.toContain('after:')
})

it.each(['labels', 'reviewRequests', 'unavailable'])(
  'retains the rich CLI fallback for %s',
  async (reason) => {
    api.specialNodes = rows()
    if (reason !== 'unavailable') {
      api.specialNodes[0][reason] = { nodes: [], pageInfo: { hasNextPage: true } }
    }
    capture.mockImplementation(async (binary, args, options) => {
      if (reason === 'unavailable' && args.includes('graphql')) {
        throw Object.assign(new Error('GraphQL unavailable'), { stderr: 'HTTP 500: unavailable' })
      }
      return args[0] === 'pr'
        ? {
            stdout: JSON.stringify([
              {
                number: 7,
                title: 'Fallback',
                state: 'OPEN',
                labels: [{ name: 'all labels' }],
                reviewRequests: [{ login: 'fallback-reviewer' }]
              }
            ]),
            stderr: ''
          }
        : api.capture(binary, args, options)
    })
    expect((await page(1))[0]).toMatchObject({
      title: 'Fallback',
      labels: ['all labels'],
      reviewRequests: [{ login: 'fallback-reviewer' }]
    })
    expect(
      capture.mock.calls.some(
        ([, args]) => args.includes('--search') && args.includes('is:open sort:created-desc')
      )
    ).toBe(true)
  }
)

it('retains the Enterprise CLI route', async () => {
  sourceContext.host = 'github.example.com'
  await listWorkItems('fixture/repo', 24, 'is:pr')
  expect(api.graphqlCalls).toBe(0)
  expect(api.calls[0].args).toContain('--json')
})

it('does not share PR cursors across credentials', async () => {
  api.specialNodes = rows()
  await page(1)
  vi.stubEnv('GH_TOKEN', 'fixture-new')
  const before = api.graphqlCalls
  expect((await page(2))[0].number).toBe(9976)
  expect(api.graphqlCalls - before).toBe(1)
  expect(api.calls.at(-1)?.args.join(' ')).toContain('first: 48')
  expect(api.calls.at(-1)?.args.join(' ')).not.toContain('after:')
})

it('routes sequential production PR pages through cursor reads', async () => {
  api.specialNodes = rows()
  const numbers: number[] = []
  capture.mockImplementation(async (binary, args, options) => {
    if (args[0] === 'pr' && args[1] === 'list') {
      const limit = Number(args[args.indexOf('--limit') + 1])
      return {
        stdout: JSON.stringify(
          rows()
            .slice(0, limit)
            .map((row) => ({
              ...row,
              labels: row.labels.nodes,
              reviewRequests: row.reviewRequests.nodes
            }))
        ),
        stderr: ''
      }
    }
    return api.capture(binary, args, options)
  })
  for (let number = 1; number <= 10; number++) {
    numbers.push(
      ...(await listWorkItems('fixture/repo', 24, 'is:pr is:open', number)).items.map(
        (item) => item.number
      )
    )
  }
  expect(numbers).toEqual(Array.from({ length: 240 }, (_, index) => 10000 - index))
  expect(
    capture.mock.calls.filter(([, args]) => args[0] === 'pr' && args[1] === 'list')
  ).toHaveLength(0)
  expect(
    capture.mock.calls.filter(([, args]) => args.some((arg) => arg.includes('r0: search(')))
  ).toHaveLength(10)
})

it('keeps Boolean search operators inside the repository and PR constraints', async () => {
  api.specialNodes = rows()
  api.expectedSearch =
    '( is:open title:foo OR title:bar sort:created-desc ) repo:fixture/repo type:pr'
  expect(
    await listPullRequestWorkItemPage({
      ownerRepo,
      query: parseTaskQuery('is:pr is:open title:foo OR title:bar'),
      limit: 24,
      page: 1,
      options: {}
    })
  ).toHaveLength(24)
  expect(api.calls.some(({ args }) => args[0] === 'pr')).toBe(false)
})

it('combines a cold short prefix with the requested PR page', async () => {
  api.specialNodes = rows()
  expect((await page(2))[0].number).toBe(9976)
  expect(api.graphqlCalls).toBe(1)
  expect(api.calls[0].args.join(' ')).toContain('first: 48')
})

it('uses advanced search for the grouped PR query and preserves CLI bot author display', async () => {
  api.specialNodes = rows()
  api.specialNodes[0].author = {
    __typename: 'Bot',
    login: 'dependabot',
    avatarUrl: 'https://example.test/bot'
  }
  expect((await page(1))[0].author).toBe('app/dependabot')
  expect(api.calls[0].args.join(' ')).toContain('search(type: ISSUE_ADVANCED,')
})

it('isolates search response coalescing, content and cursor identity by search type', async () => {
  api.specialNodes = rows()
  const args = {
    search: 'repo:fixture/search-type-isolation is:open',
    nodeSelection: '__typename ... on PullRequest { number }',
    limit: 24,
    page: 1,
    options: {}
  }
  await Promise.all([
    searchWorkItemPage({ ...args, searchType: 'ISSUE' }),
    searchWorkItemPage({ ...args, searchType: 'ISSUE_ADVANCED' })
  ])
  expect(api.graphqlFields).toBe(2)
  await searchWorkItemPage({ ...args, searchType: 'ISSUE' })
  await searchWorkItemPage({ ...args, searchType: 'ISSUE_ADVANCED' })
  expect(api.graphqlFields).toBe(2)

  const cold = { ...args, search: 'repo:fixture/cursor-type-isolation is:open' }
  await searchWorkItemPage({ ...cold, searchType: 'ISSUE' })
  expect(await searchWorkItemPage({ ...cold, page: 2, searchType: 'ISSUE_ADVANCED' })).toHaveLength(
    24
  )
  expect(api.calls.at(-1)?.args.join(' ')).toContain('first: 48')
})

it('does not attach legacy count readers to advanced pages or seed their cache', async () => {
  api.specialNodes = rows()
  const search = 'repo:fixture/count-type-isolation is:open'
  const advancedPage = () =>
    searchWorkItemPage({
      search,
      searchType: 'ISSUE_ADVANCED',
      nodeSelection: '__typename ... on PullRequest { number }',
      limit: 24,
      page: 1,
      options: {}
    })
  const legacyCount = () =>
    requestWorkItemSearch({ search, first: 1, selection: 'issueCount', options: {} })
  await Promise.all([advancedPage(), legacyCount()])
  expect(api.graphqlFields).toBe(2)

  await searchWorkItemPage({
    search: `${search} label:only-advanced`,
    searchType: 'ISSUE_ADVANCED',
    nodeSelection: '__typename ... on PullRequest { number }',
    limit: 24,
    page: 1,
    options: {}
  })
  const before = api.graphqlFields
  await requestWorkItemSearch({
    search: `${search} label:only-advanced`,
    first: 1,
    selection: 'issueCount',
    options: {}
  })
  expect(api.graphqlFields - before).toBe(1)
})
