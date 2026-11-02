import { vi } from 'vitest'
import type { AzureDevOpsRepoRef } from '../repository-ref'

export const CLOUD_REPO: AzureDevOpsRepoRef = {
  host: 'dev.azure.com',
  organization: 'acme',
  project: 'Project',
  repository: 'repo',
  apiBaseUrl: 'https://dev.azure.com/acme/Project',
  webBaseUrl: 'https://dev.azure.com/acme/Project/_git/repo'
}

type Route = unknown

/** Route table keyed by pathname; the value is the JSON body or a function producing it. */
export function installAzureDevOpsFetchFixture(routes: Record<string, Route>): { calls: URL[] } {
  const calls: URL[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the call signature the clients use; vi.fn's return type lacks fetch's preconnect member.
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(url)
    const route = routes[url.pathname]
    if (route === undefined) {
      return new Response(JSON.stringify({ message: `no fixture for ${url.pathname}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    const body =
      typeof route === 'function'
        ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the function branch of Route is exactly this signature; the union is narrowed by typeof above.
          (route as (u: URL, i?: RequestInit) => unknown)(url, init)
        : route
    return Response.json(body)
  }) as never
  return { calls }
}

export const TEAMS_RESPONSE = {
  value: [
    { id: 'team-1', name: 'Platform' },
    { id: 'team-2', name: 'Mobile' }
  ]
}

export const PROJECT_RESPONSE = {
  id: 'proj-1',
  name: 'Project',
  defaultTeam: { id: 'team-2', name: 'Mobile' }
}

export const ITERATIONS_RESPONSE = {
  value: [
    {
      id: 'it-1',
      name: '2026',
      path: 'Project\\2026',
      attributes: {
        startDate: '2026-07-01T00:00:00Z',
        finishDate: '2026-12-01T00:00:00Z',
        timeFrame: 'current'
      }
    },
    {
      id: 'it-0',
      name: 'Backlog',
      path: 'Project',
      attributes: { startDate: null, finishDate: null, timeFrame: null }
    }
  ]
}

export const BACKLOG_CONFIGURATION_RESPONSE = {
  bugsBehavior: 'asRequirements',
  hiddenBacklogs: ['Microsoft.EpicCategory'],
  portfolioBacklogs: [
    {
      id: 'Microsoft.EpicCategory',
      name: 'Epics',
      rank: 4,
      workItemTypes: [{ name: 'Epic' }],
      columnFields: [
        {
          columnFieldReference: { referenceName: 'System.WorkItemType', name: 'Work Item Type' },
          width: 100
        },
        { columnFieldReference: { referenceName: 'System.Title', name: 'Title' }, width: 400 }
      ]
    },
    {
      id: 'Microsoft.FeatureCategory',
      name: 'Features',
      rank: 3,
      workItemTypes: [{ name: 'Feature' }],
      columnFields: [
        {
          columnFieldReference: { referenceName: 'System.WorkItemType', name: 'Work Item Type' },
          width: 100
        },
        { columnFieldReference: { referenceName: 'System.Title', name: 'Title' }, width: 400 },
        { columnFieldReference: { referenceName: 'System.State', name: 'State' }, width: 100 },
        {
          columnFieldReference: {
            referenceName: 'Microsoft.VSTS.Common.BusinessValue',
            name: 'Business Value'
          },
          width: 50
        },
        { columnFieldReference: { referenceName: 'System.Tags', name: 'Tags' }, width: 200 }
      ]
    }
  ],
  requirementBacklog: {
    id: 'Microsoft.RequirementCategory',
    name: 'Backlog items',
    rank: 2,
    workItemTypes: [{ name: 'Product Backlog Item' }, { name: 'Bug' }],
    columnFields: [
      {
        columnFieldReference: { referenceName: 'System.WorkItemType', name: 'Work Item Type' },
        width: 100
      },
      { columnFieldReference: { referenceName: 'System.Title', name: 'Title' }, width: 400 },
      { columnFieldReference: { referenceName: 'System.State', name: 'State' }, width: 100 },
      {
        columnFieldReference: { referenceName: 'Microsoft.VSTS.Scheduling.Effort', name: 'Effort' },
        width: 50
      },
      {
        columnFieldReference: { referenceName: 'System.IterationPath', name: 'Iteration Path' },
        width: 200
      },
      { columnFieldReference: { referenceName: 'System.Tags', name: 'Tags' }, width: 200 }
    ]
  },
  taskBacklog: {
    id: 'Microsoft.TaskCategory',
    name: 'Tasks',
    rank: 1,
    workItemTypes: [{ name: 'Task' }],
    columnFields: [
      { columnFieldReference: { referenceName: 'System.Title', name: 'Title' }, width: 400 },
      { columnFieldReference: { referenceName: 'System.State', name: 'State' }, width: 100 },
      {
        columnFieldReference: { referenceName: 'System.AssignedTo', name: 'Assigned To' },
        width: 100
      }
    ]
  }
}

export const WORK_ITEM_TYPES_RESPONSE = {
  value: [
    {
      name: 'Feature',
      color: '773B93',
      icon: {
        id: 'icon_trophy',
        url: 'https://tfsprodcus3.visualstudio.com/_apis/wit/workItemIcons/icon_trophy?color=773B93&v=2'
      },
      states: [
        { name: 'New', color: 'b2b2b2', category: 'Proposed' },
        { name: 'In Progress', color: '007acc', category: 'InProgress' },
        { name: 'Done', color: '339933', category: 'Completed' }
      ]
    },
    {
      name: 'Product Backlog Item',
      color: '009CCC',
      icon: { id: 'icon_list' },
      states: [
        { name: 'New', color: 'b2b2b2', category: 'Proposed' },
        { name: 'Approved', color: 'b2b2b2', category: 'Proposed' },
        { name: 'Committed', color: '007acc', category: 'InProgress' },
        { name: 'Done', color: '339933', category: 'Completed' }
      ]
    },
    {
      name: 'Bug',
      color: 'CC293D',
      icon: { id: 'icon_insect' },
      states: [{ name: 'New', color: 'b2b2b2', category: 'Proposed' }]
    },
    {
      name: 'Task',
      color: 'F2CB1D',
      icon: { id: 'icon_clipboard' },
      states: [{ name: 'To Do', color: 'b2b2b2', category: 'Proposed' }]
    }
  ]
}

/** `Settings/WebTeam/{team}/Entries/me/Agile/BacklogsHub`, as captured live: JSON strings inside JSON. */
export const BACKLOG_HUB_SETTINGS_RESPONSE = {
  count: 5,
  value: {
    'ColumnOptions/Microsoft.FeatureCategory': JSON.stringify([
      { name: 'System.WorkItemType', text: 'Work Item Type', width: 100 },
      { name: 'System.Title', text: 'Title', width: 400, fieldType: 1, canSortBy: true },
      { id: -7, name: 'System.AreaPath', text: 'Area Path', fieldType: 8, width: 178 },
      {
        name: 'System.Backlog.Rollup.ProgressBy.AllCompletedDescendants',
        text: 'Progress by all Work Items',
        width: 100,
        rollup: true,
        rollupCalculation: { type: 'count' }
      },
      { name: 'System.Parent', text: 'Parent', width: 200 }
    ]),
    'ColumnOptions/ProductBacklogColumnOptions': JSON.stringify([
      { name: 'System.Title', text: 'Title', width: 320 },
      { name: 'System.State', text: 'State', width: 90 },
      { name: 'System.Parent', text: 'Parent', width: 200 },
      { name: 'System.Tags', text: 'Tags', width: 160 }
    ]),
    ShowParentsFilter: true,
    InProgressFilter: false,
    KeepHierarchyWithFilters: false,
    BacklogId: 'Microsoft.RequirementCategory'
  }
}

/** `Settings/WebTeam/{team}/Entries/me/Backlogs/backlog`: one saved filter per level name. */
export const BACKLOG_SAVED_FILTERS_RESPONSE = {
  count: 1,
  value: {
    'Backlog items/Filter': JSON.stringify({
      text: 'login',
      'System.WorkItemType': {
        value: [{ key: 'Bug', value: 'Bug', display: 'Bug' }]
      },
      'System.AssignedTo': {
        value: [{ key: 'Ada Lovelace', value: 'Ada Lovelace', display: 'Ada Lovelace' }]
      },
      'System.Tags': { value: [{ key: 'urgent', value: 'urgent', display: 'urgent' }] },
      'Custom.Unknown': { value: [{ key: 'x', value: 'x', display: 'x' }] }
    })
  }
}

/** `wit/workitems` shape with `fields` requested (identity refs are objects). */
export function rawWorkItem(id: number, fields: Record<string, unknown>) {
  return {
    id,
    rev: 3,
    fields: { 'System.Id': id, ...fields },
    url: `https://dev.azure.com/acme/_apis/wit/workItems/${id}`
  }
}
