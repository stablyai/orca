import { buildSchema, graphql } from 'graphql'
import { expect, it, vi } from 'vitest'
import { CHILDREN_QUERY, childrenPageSize, ISSUE_QUERY, SEARCH_QUERY } from './raw'

const schema = buildSchema(`
  type Query { issue(id: String!): Issue, searchIssues(term: String!, first: Int): Issues }
  type Issue {
    id: String, identifier: String, title: String, url: String, description: String,
    priority: Int, estimate: Float, dueDate: String, branchName: String,
    createdAt: String, updatedAt: String, state: Named, team: Named, project: Named,
    cycle: Named, assignee: User, labels(first: Int): Labels,
    children(first: Int, after: String): Issues
  }
  type Named { id: String, name: String, type: String, color: String, key: String, url: String }
  type User { id: String, displayName: String, avatarUrl: String }
  type Label { id: String, name: String, color: String }
  type Labels { nodes: [Label], pageInfo: PageInfo }
  type Issues { nodes: [Issue], pageInfo: PageInfo }
  type PageInfo { hasNextPage: Boolean, endCursor: String }
`)

const issue = {
  id: 'issue',
  createdAt: '2026-11-02T00:00:00Z',
  state: { id: 'state', name: 'Todo' },
  team: { id: 'team', color: 'blue' },
  project: { id: 'project', url: 'https://linear.app/project' },
  cycle: { id: 'cycle', name: 'Sprint' },
  labels: { nodes: [{ id: 'label', name: 'Bug', color: 'red' }], pageInfo: { hasNextPage: false } }
}
const agentProjection = {
  createdAt: issue.createdAt,
  state: { id: 'state' },
  team: { color: 'blue' },
  cycle: issue.cycle,
  labels: { nodes: [{ color: 'red' }], pageInfo: { hasNextPage: false } }
}

it('drawer selection never invokes agent-only resolvers that could hide readable detail', async () => {
  const cycle = vi.fn(() => {
    throw new Error('Cycle resolver unavailable')
  })
  const result = await graphql({
    schema,
    source: ISSUE_QUERY,
    variableValues: { id: issue.id, includeDrawerFields: true },
    rootValue: { issue: { ...issue, cycle, children: { nodes: [] } } }
  })
  expect(result.errors).toBeUndefined()
  expect(cycle).not.toHaveBeenCalled()
  expect(result.data).not.toHaveProperty('issue.createdAt')
  expect(result.data).not.toHaveProperty('issue.cycle')
  expect(result.data).toMatchObject({
    issue: { id: issue.id, project: { url: issue.project.url }, children: { nodes: [] } }
  })
})

it.each([
  {
    name: 'default issue',
    query: ISSUE_QUERY,
    variables: { id: issue.id },
    data: { issue: agentProjection }
  },
  {
    name: 'search',
    query: SEARCH_QUERY,
    variables: { term: 'issue' },
    data: { searchIssues: { nodes: [agentProjection] } }
  },
  {
    name: 'children',
    query: CHILDREN_QUERY(1),
    variables: { id: issue.id, first: childrenPageSize(1) },
    data: { issue: { children: { nodes: [agentProjection] } } }
  }
])(
  'retains all agent fields for $name without declaring drawer variables',
  async ({ query, variables, data }) => {
    const result = await graphql({
      schema,
      source: query,
      variableValues: variables,
      rootValue: {
        issue: { ...issue, children: { nodes: [issue] } },
        searchIssues: { nodes: [issue] }
      }
    })
    expect(result.errors).toBeUndefined()
    expect(result.data).toMatchObject(data)
  }
)
