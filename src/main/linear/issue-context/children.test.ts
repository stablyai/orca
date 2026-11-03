import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedIssue } from './client'
import { readChildren } from './children'
import { CHILDREN_QUERY, childrenPageSize, ISSUE_FIELDS, type RawChildIssue } from './raw'

const rawRequest = vi.hoisted(() => vi.fn())
vi.mock('./client', () => ({
  getRequiredEntry: () => ({}),
  withLinearRead: async (_entry: unknown, read: () => Promise<unknown>) => read()
}))
vi.mock('../client', () => ({
  getPublicFileUrlClient: () => ({ client: { rawRequest } })
}))

const resolved: ResolvedIssue = {
  workspace: {
    id: 'workspace',
    organizationId: 'workspace',
    organizationName: 'Acme',
    displayName: 'Ada',
    email: 'ada@example.com'
  },
  issue: {
    id: 'parent',
    identifier: 'ENG-1',
    title: 'Parent',
    url: 'https://linear.app/issue/ENG-1',
    labels: []
  }
}

function child(id: string): RawChildIssue {
  return {
    id,
    identifier: id,
    title: id,
    url: `https://linear.app/issue/${id}`,
    description: `![image](https://uploads.linear.app/${id}?sig=1)`,
    state: { name: 'Todo' },
    labels: { nodes: [{ name: 'Bug' }] }
  }
}

function children(count: number, prefix = 'child'): RawChildIssue[] {
  return Array.from({ length: count }, (_, index) => child(`${prefix}-${index}`))
}

// The provider fixture honors every selected first argument, including nested pages.
function provider(tree: Record<string, RawChildIssue[]>) {
  rawRequest.mockImplementation(
    async (query: string, page: { id: string; first: number; after?: string }) => {
      const sizes = [...query.matchAll(/children\(first: (\$first|\d+)/g)].map((match) =>
        match[1] === '$first' ? page.first : Number(match[1])
      )
      function connection(id: string, level: number, after = 0): object {
        const all = tree[id] ?? []
        const end = Math.min(all.length, after + sizes[level])
        return {
          nodes: all.slice(after, end).map((node) => ({
            ...node,
            ...(level + 1 < sizes.length ? { children: connection(node.id, level + 1) } : {})
          })),
          pageInfo: { hasNextPage: end < all.length, endCursor: String(end) }
        }
      }
      return { data: { issue: { children: connection(page.id, 0, Number(page.after ?? 0)) } } }
    }
  )
}

describe('nested Linear children', () => {
  beforeEach(() => {
    rawRequest.mockReset()
  })

  it.each([15, 150, 200])(
    'reads %i leaves once per parent page without leaf probes',
    async (count) => {
      provider({ parent: children(count) })
      const output = await readChildren(resolved, 2)
      expect(output.items).toHaveLength(count)
      expect(output.items[0]).toMatchObject({
        ...child('child-0'),
        labels: [{ name: 'Bug' }],
        mayHaveMore: count === 200
      })
      expect(output.items[0]).not.toHaveProperty('children')
      expect(output.meta).toEqual({
        returned: count,
        cap: 200,
        capReached: count === 200,
        mayHaveMore: count === 200
      })
      expect(rawRequest).toHaveBeenCalledTimes(Math.ceil(count / 50))
      expect(
        rawRequest.mock.calls.every(([, page]) => page.id === 'parent' && page.first === 50)
      ).toBe(true)
    }
  )

  it('continues only advertised child connections with their independent cursors', async () => {
    provider({
      parent: [child('A'), child('B'), child('leaf')],
      A: children(60, 'A'),
      B: children(3, 'B')
    })
    const output = await readChildren(resolved, 2)
    expect(output.items[0].children?.map((node) => node.id)).toEqual(
      children(60, 'A').map((node) => node.id)
    )
    expect(output.items[1].children).toHaveLength(3)
    expect(output.items[2]).not.toHaveProperty('children')
    expect(output.items[0].children?.[0].mayHaveMore).toBe(true)
    expect(output.items[0].mayHaveMore).toBe(false)
    expect(output.meta).toEqual({ returned: 66, cap: 200, capReached: false, mayHaveMore: true })
    expect(rawRequest.mock.calls.map(([, page]) => page)).toEqual([
      { id: 'parent', first: 50 },
      { id: 'A', first: 50, after: '1' },
      { id: 'A', first: 50, after: '51' },
      { id: 'B', first: 50, after: '1' }
    ])
  })

  it('reserves the cap for root siblings before descendants', async () => {
    provider({ parent: children(150), 'child-0': children(100, 'grandchild') })
    const output = await readChildren(resolved, 2)
    expect(output.items.map((node) => node.id)).toEqual(children(150).map((node) => node.id))
    expect(output.items[0].children?.map((node) => node.id)).toEqual(
      children(50, 'grandchild').map((node) => node.id)
    )
    expect(output.meta.returned).toBe(200)
    expect(rawRequest.mock.calls.map(([, page]) => page)).toEqual([
      { id: 'parent', first: 50 },
      { id: 'parent', first: 50, after: '50' },
      { id: 'parent', first: 50, after: '100' },
      { id: 'child-0', first: 49, after: '1' }
    ])
  })

  it('allocates each sibling group before descending and visits subtrees in order', async () => {
    provider({
      parent: [child('A'), child('B')],
      A: children(100),
      'child-0': children(100, 'deep'),
      B: children(5, 'B')
    })
    const output = await readChildren(resolved, 3)
    expect(output.items[0].children).toHaveLength(100)
    expect(output.items[0].children?.[0].children?.map((node) => node.id)).toEqual(
      children(98, 'deep').map((node) => node.id)
    )
    expect(output.items[1]).not.toHaveProperty('children')
    expect(output.meta.returned).toBe(200)
    expect(rawRequest.mock.calls.some(([, page]) => page.id === 'B')).toBe(false)
  })

  it('returns depth zero without a query and retains its metadata shape', async () => {
    expect(await readChildren(resolved, 0)).toEqual({
      items: [],
      meta: { returned: 0, cap: 200, capReached: false, hasMore: false }
    })
    expect(rawRequest).not.toHaveBeenCalled()
  })

  it.each(['missing', 'repeated', 'empty'])(
    'terminates a %s continuation without erasing incompleteness',
    async (failure) => {
      rawRequest.mockResolvedValueOnce({
        data: {
          issue: {
            children: {
              nodes: [child('A')],
              pageInfo: { hasNextPage: true, endCursor: failure === 'missing' ? null : 'cursor' }
            }
          }
        }
      })
      rawRequest.mockResolvedValueOnce({
        data: {
          issue: {
            children: {
              nodes: failure === 'empty' ? [] : [child('B')],
              pageInfo: { hasNextPage: true, endCursor: 'cursor' }
            }
          }
        }
      })
      const output = await readChildren(resolved, 2)
      expect(output.meta).toMatchObject({ capReached: true, mayHaveMore: true })
      expect(rawRequest).toHaveBeenCalledTimes(failure === 'missing' ? 1 : 2)
    }
  )

  it('selects full issue fields with bounded explicit pages at every supported depth', async () => {
    for (let depth = 1; depth <= 5; depth += 1) {
      const query = CHILDREN_QUERY(depth)
      expect(query.match(/children\(first:/g)).toHaveLength(depth)
      expect(query.match(/pageInfo \{ hasNextPage endCursor \}/g)).toHaveLength(depth)
      expect(query.split(ISSUE_FIELDS)).toHaveLength(depth + 1)
      const first = childrenPageSize(depth)
      const projectedIssues = first * depth
      // Conservative documented-model estimate: 80 per issue plus child/page wrappers.
      expect(projectedIssues * 80 + (projectedIssues + 1) * 4 + 10).toBeLessThan(10_000)
      expect(first).toBeLessThanOrEqual(50)
    }
    provider({
      parent: [child('A')],
      A: [child('B')],
      B: [child('C')],
      C: [child('D')],
      D: [child('E')],
      E: [child('outside-depth')]
    })
    const output = await readChildren(resolved, 5)
    expect(output.meta).toMatchObject({ returned: 5, capReached: false, mayHaveMore: true })
    expect(output.items[0].children?.[0].children?.[0].children?.[0].children?.[0]).toMatchObject({
      id: 'E',
      mayHaveMore: true
    })
    expect(rawRequest).toHaveBeenCalledTimes(1)
  })
})
