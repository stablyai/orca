import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildAzureDevOpsAssignedWorkItemsWiql,
  loadAzureDevOpsAssignedWorkItems
} from './assigned-work-items-client'
import { CLOUD_REPO, installAzureDevOpsFetchFixture, rawWorkItem } from './test-fixtures'

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch
const TYPES = '/acme/Project/_apis/wit/workitemtypes'
const WIQL = '/acme/Project/_apis/wit/wiql'
const ITEMS = '/acme/Project/_apis/wit/workitems'

const TYPES_RESPONSE = {
  value: [
    {
      name: 'Product Backlog Item',
      states: [
        { name: 'New', category: 'Proposed' },
        { name: 'Removed', category: 'Removed' }
      ]
    },
    { name: 'Bug', states: [{ name: 'Cut', category: 'Removed' }] }
  ]
}

function itemsRoute() {
  return (url: URL) => ({
    value: (url.searchParams.get('ids') ?? '')
      .split(',')
      .map(Number)
      .map((id) =>
        rawWorkItem(id, {
          'System.WorkItemType': 'Bug',
          'System.Title': `Item ${id}`,
          'System.State': 'Active',
          'System.ChangedDate': '2026-10-30T00:00:00Z'
        })
      )
  })
}

beforeEach(() => {
  process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat' }
})

afterEach(() => {
  process.env = OLD_ENV
  globalThis.fetch = OLD_FETCH
  vi.restoreAllMocks()
})

describe('assigned work items WIQL', () => {
  it('scopes by project and @Me, with no team area or work item type clause', () => {
    expect(buildAzureDevOpsAssignedWorkItemsWiql('Project')).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Project' AND " +
        '[System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC'
    )
  })

  it('excludes the Removed states, so the query never spends its budget on them', () => {
    expect(buildAzureDevOpsAssignedWorkItemsWiql('Project', ['Removed', "Cut'n"])).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Project' AND " +
        "[System.AssignedTo] = @Me AND [System.State] NOT IN ('Removed', 'Cut''n') " +
        'ORDER BY [System.ChangedDate] DESC'
    )
  })
})

describe('loadAzureDevOpsAssignedWorkItems', () => {
  it('sends the Removed states of every project type and keeps the query order', async () => {
    const fixture = installAzureDevOpsFetchFixture({
      [TYPES]: TYPES_RESPONSE,
      [WIQL]: { workItems: [{ id: 7 }, { id: 3 }] },
      [ITEMS]: itemsRoute()
    })
    const page = await loadAzureDevOpsAssignedWorkItems(CLOUD_REPO)
    expect(page.items.map((i) => i.id)).toEqual([7, 3])
    expect(page.unhydratedItemCount).toBe(0)
    const body = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([input]) => new URL(String(input)).pathname === WIQL)?.[1]?.body
    expect(String(body)).toContain("NOT IN ('Removed', 'Cut')")
    expect(fixture.calls.some((u) => u.pathname === ITEMS)).toBe(true)
  })

  it('counts items the batch fetch omitted rather than presenting a short list', async () => {
    installAzureDevOpsFetchFixture({
      [TYPES]: TYPES_RESPONSE,
      [WIQL]: { workItems: [{ id: 1 }, { id: 2 }] },
      [ITEMS]: {
        value: [rawWorkItem(1, { 'System.WorkItemType': 'Bug', 'System.Title': 'Only one' })]
      }
    })
    const page = await loadAzureDevOpsAssignedWorkItems(CLOUD_REPO)
    expect(page.items.map((i) => i.id)).toEqual([1])
    expect(page.unhydratedItemCount).toBe(1)
  })

  it('rejects when the query itself fails, instead of reading as nothing assigned', async () => {
    const stub = vi.fn(async (input: string | URL | Request) =>
      new URL(String(input)).pathname === WIQL
        ? new Response('nope', { status: 403 })
        : Response.json(TYPES_RESPONSE)
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements the call signature the client uses; vi.fn's return type lacks fetch's preconnect member.
    globalThis.fetch = stub as never
    await expect(loadAzureDevOpsAssignedWorkItems(CLOUD_REPO)).rejects.toThrow()
  })

  it('returns an empty list, not a failure, when nothing is assigned', async () => {
    installAzureDevOpsFetchFixture({ [TYPES]: TYPES_RESPONSE, [WIQL]: { workItems: [] } })
    await expect(loadAzureDevOpsAssignedWorkItems(CLOUD_REPO)).resolves.toEqual({
      items: [],
      unhydratedItemCount: 0
    })
  })
})
