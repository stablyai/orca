import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AzureDevOpsBacklogLevel } from '../../../shared/azure-devops/boards-types'
import {
  hydrateAzureDevOpsWorkItems,
  listAzureDevOpsChildIds,
  loadAzureDevOpsBacklogPage
} from './backlog-client'
import { CLOUD_REPO, installAzureDevOpsFetchFixture, rawWorkItem } from './test-fixtures'

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch
const WIT = '/acme/Project/_apis/wit'

const LEVEL: AzureDevOpsBacklogLevel = {
  id: 'Microsoft.RequirementCategory',
  name: 'Backlog items',
  rank: 2,
  kind: 'requirement',
  workItemTypes: ['Product Backlog Item', 'Bug'],
  columnFields: [
    { referenceName: 'System.Title', name: 'Title', width: 400 },
    { referenceName: 'Microsoft.VSTS.Scheduling.Effort', name: 'Effort', width: 50 }
  ],
  hidden: false
}

function pbi(id: number, parent: number | null, rank: number) {
  return rawWorkItem(id, {
    'System.WorkItemType': 'Product Backlog Item',
    'System.Title': `PBI ${id}`,
    'System.State': 'Approved',
    'System.Parent': parent,
    'Microsoft.VSTS.Common.StackRank': rank
  })
}
function task(id: number, parent: number, rank: number) {
  return rawWorkItem(id, {
    'System.WorkItemType': 'Task',
    'System.Title': `Task ${id}`,
    'System.State': 'To Do',
    'System.Parent': parent,
    'Microsoft.VSTS.Common.StackRank': rank
  })
}
function feature(id: number, parent: number | null = null) {
  return rawWorkItem(id, {
    'System.WorkItemType': 'Feature',
    'System.Title': `Feature ${id}`,
    'System.State': 'In Progress',
    'System.Parent': parent
  })
}

/** Serves `wit/workitems?ids=` from a pool, in the requested order. */
function workItemsRoute(pool: Record<number, ReturnType<typeof rawWorkItem>>) {
  return (url: URL) => ({
    value: (url.searchParams.get('ids') ?? '')
      .split(',')
      .map(Number)
      .filter((id) => pool[id])
      .map((id) => pool[id])
  })
}

describe('backlog client', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat-token' }
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
  })
  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
  })

  it('hydrates in batches of 200 with base + extra fields and preserves order', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => i + 1)
    const pool = Object.fromEntries(ids.map((id) => [id, pbi(id, null, id)]))
    const { calls } = installAzureDevOpsFetchFixture({ [`${WIT}/workitems`]: workItemsRoute(pool) })

    const items = await hydrateAzureDevOpsWorkItems(CLOUD_REPO, ids, [
      'Microsoft.VSTS.Scheduling.Effort'
    ])

    expect(items.map((i) => i.id)).toEqual(ids)
    const witCalls = calls.filter((u) => u.pathname === `${WIT}/workitems`)
    expect(witCalls).toHaveLength(2)
    expect(witCalls[0].searchParams.get('ids')?.split(',')).toHaveLength(200)
    expect(witCalls[0].searchParams.get('errorPolicy')).toBe('omit')
    expect(witCalls[0].searchParams.get('fields')).toContain('Microsoft.VSTS.Scheduling.Effort')
    expect(witCalls[0].searchParams.get('fields')).toContain('System.Parent')
  })

  it('returns children per parent from a hierarchy link query', async () => {
    const { calls } = installAzureDevOpsFetchFixture({
      [`${WIT}/wiql`]: {
        workItemRelations: [
          { rel: null, source: null, target: { id: 10 } },
          { rel: 'System.LinkTypes.Hierarchy-Forward', source: { id: 10 }, target: { id: 101 } },
          { rel: 'System.LinkTypes.Hierarchy-Forward', source: { id: 10 }, target: { id: 102 } },
          { rel: null, source: null, target: { id: 11 } }
        ]
      }
    })
    await expect(listAzureDevOpsChildIds(CLOUD_REPO, [10, 11])).resolves.toEqual({
      10: [101, 102],
      11: []
    })
    const wiql = calls.find((u) => u.pathname === `${WIT}/wiql`)
    expect(wiql).toBeDefined()
  })

  it('returns an empty map without calling the API when there are no parents', async () => {
    const { calls } = installAzureDevOpsFetchFixture({})
    await expect(listAzureDevOpsChildIds(CLOUD_REPO, [])).resolves.toEqual({})
    expect(calls).toHaveLength(0)
  })

  it('loads a level page: ordered items, one level of children, referenced parents and their parents', async () => {
    const pool = {
      10: pbi(10, 70, 1),
      11: pbi(11, null, 2),
      101: task(101, 10, 5),
      102: task(102, 10, 4),
      70: feature(70, 900),
      900: rawWorkItem(900, {
        'System.WorkItemType': 'Epic',
        'System.Title': 'Epic 900',
        'System.State': 'New'
      })
    }
    const { calls } = installAzureDevOpsFetchFixture({
      '/acme/Project/Mobile/_apis/work/backlogs/Microsoft.RequirementCategory/workItems': {
        workItems: [{ target: { id: 10 } }, { target: { id: 11 } }]
      },
      [`${WIT}/workitems`]: workItemsRoute(pool),
      [`${WIT}/wiql`]: {
        workItemRelations: [
          { rel: null, source: null, target: { id: 10 } },
          { rel: 'System.LinkTypes.Hierarchy-Forward', source: { id: 10 }, target: { id: 101 } },
          { rel: 'System.LinkTypes.Hierarchy-Forward', source: { id: 10 }, target: { id: 102 } }
        ]
      }
    })

    const page = await loadAzureDevOpsBacklogPage(CLOUD_REPO, 'Mobile', LEVEL, [
      'System.Parent',
      'Custom.Priority'
    ])

    expect(page.level).toBe(LEVEL)
    expect(page.items.map((i) => i.id)).toEqual([10, 11])
    // Why: children are sorted by StackRank, not by link order.
    expect(page.childrenByParent).toEqual({ 10: [102, 101], 11: [] })
    expect(page.children.map((c) => c.id).sort()).toEqual([101, 102])
    expect(page.parents.map((p) => p.id)).toEqual([70])
    // Why: the Feature's Epic sits on a hidden level; the Parent column still needs its title.
    expect(page.ancestors?.map((a) => a.id)).toEqual([900])
    const hydrations = calls.filter((u) => u.pathname === `${WIT}/workitems`)
    expect(hydrations[0].searchParams.get('fields')).toContain('Custom.Priority')
    expect(hydrations.map((u) => u.searchParams.get('ids'))).toEqual([
      '10,11',
      '101,102',
      '70',
      '900'
    ])
  })

  it('counts the level items the batch omitted, and keeps the ones that loaded', async () => {
    // Why: errorPolicy=omit drops a deleted or now-invisible item; the list says so.
    installAzureDevOpsFetchFixture({
      '/acme/Project/Mobile/_apis/work/backlogs/Microsoft.RequirementCategory/workItems': {
        workItems: [{ target: { id: 10 } }, { target: { id: 11 } }]
      },
      [`${WIT}/workitems`]: { value: [pbi(10, null, 1)] },
      [`${WIT}/wiql`]: { workItemRelations: [] }
    })
    const page = await loadAzureDevOpsBacklogPage(CLOUD_REPO, 'Mobile', LEVEL)
    expect(page.items.map((i) => i.id)).toEqual([10])
    expect(page.unhydratedItemCount).toBe(1)
  })

  it('throws when the level items cannot be hydrated, rather than reading as an empty level', async () => {
    installAzureDevOpsFetchFixture({
      '/acme/Project/Mobile/_apis/work/backlogs/Microsoft.RequirementCategory/workItems': {
        workItems: [{ target: { id: 10 } }]
      }
    })
    await expect(loadAzureDevOpsBacklogPage(CLOUD_REPO, 'Mobile', LEVEL)).rejects.toThrow(
      'HTTP 404'
    )
  })

  it('throws with the HTTP status when the ordered-id request fails', async () => {
    installAzureDevOpsFetchFixture({})
    await expect(loadAzureDevOpsBacklogPage(CLOUD_REPO, 'Mobile', LEVEL)).rejects.toThrow(
      'HTTP 404'
    )
  })
})
