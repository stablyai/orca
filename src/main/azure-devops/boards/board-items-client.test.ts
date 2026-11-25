import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AzureDevOpsBacklogLevel,
  AzureDevOpsBoardConfiguration
} from '../../../shared/azure-devops/boards-types'
import {
  buildAzureDevOpsBoardWiql,
  loadAzureDevOpsBoardPage,
  removedStateNames,
  resolveAzureDevOpsBoardForLevel
} from './board-items-client'
import { CLOUD_REPO, installAzureDevOpsFetchFixture, rawWorkItem } from './test-fixtures'

const configClient = vi.hoisted(() => ({
  listAzureDevOpsBoards: vi.fn(),
  getAzureDevOpsBoardConfiguration: vi.fn()
}))
vi.mock('./board-configuration-client', () => configClient)

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch
const TEAM = '/acme/Project/Mobile/_apis/work/teamsettings/teamfieldvalues'
const WIQL = '/acme/Project/_apis/wit/wiql'
const ITEMS = '/acme/Project/_apis/wit/workitems'

const LEVEL: AzureDevOpsBacklogLevel = {
  id: 'Microsoft.RequirementCategory',
  name: 'Backlog items',
  rank: 2,
  kind: 'requirement',
  workItemTypes: ['Product Backlog Item', 'Bug'],
  columnFields: [],
  hidden: false
}

const CONFIGURATION: AzureDevOpsBoardConfiguration = {
  id: 'b1',
  name: 'Backlog items',
  columns: [],
  rows: [],
  columnField: 'WEF_Board_Kanban.Column',
  rowField: 'WEF_Board_Kanban.Lane',
  doneField: 'WEF_Board_Kanban.Column.Done',
  cardFields: {
    Bug: {
      fields: [
        { referenceName: 'System.AssignedTo', core: true },
        { referenceName: 'Custom.Severity', core: false }
      ],
      showEmptyFields: false
    }
  },
  tagColors: {},
  styleRules: []
}

const AREAS = {
  field: { referenceName: 'System.AreaPath' },
  defaultValue: 'Project',
  values: [{ value: 'Project', includeChildren: true }]
}

function itemsRoute(parentOf: Record<number, number> = {}) {
  return (url: URL) => ({
    value: (url.searchParams.get('ids') ?? '')
      .split(',')
      .map(Number)
      .map((id) =>
        rawWorkItem(id, {
          'System.WorkItemType': 'Product Backlog Item',
          'System.Title': `Item ${id}`,
          'System.State': 'Approved',
          'System.Parent': parentOf[id] ?? null
        })
      )
  })
}

describe('board WIQL and board matching', () => {
  it('queries the level’s types inside the team’s area paths, ordered by stack rank', () => {
    const wiql = buildAzureDevOpsBoardWiql('Project', LEVEL, {
      field: 'System.AreaPath',
      defaultValue: 'Project\\Web',
      values: [
        { value: 'Project\\Web', includeChildren: true },
        { value: 'Project\\Api', includeChildren: false }
      ]
    })
    expect(wiql).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Project' AND " +
        "[System.WorkItemType] IN ('Product Backlog Item', 'Bug') AND " +
        "([System.AreaPath] UNDER 'Project\\Web' OR [System.AreaPath] = 'Project\\Api') " +
        'ORDER BY [Microsoft.VSTS.Common.StackRank]'
    )
  })

  it('excludes the Removed states, so the query never spends its budget on them', () => {
    const wiql = buildAzureDevOpsBoardWiql(
      'Project',
      LEVEL,
      {
        field: null,
        defaultValue: 'Project\\Web',
        values: [{ value: 'Project\\Web', includeChildren: true }]
      },
      ['Removed', 'Cut']
    )
    expect(wiql).toContain("AND [System.State] NOT IN ('Removed', 'Cut') ORDER BY")
  })

  it('names the Removed states of the level’s own types only', () => {
    const states = (names: [string, string][]) =>
      names.map(([name, category]) => ({
        name,
        color: null,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pairs above are state categories; the tuple type is widened to string by the literal.
        category: category as 'Removed' | 'Proposed'
      }))
    const metadata = {
      'Product Backlog Item': {
        name: 'Product Backlog Item',
        color: null,
        iconId: null,
        iconUrl: null,
        states: states([
          ['New', 'Proposed'],
          ['Removed', 'Removed']
        ])
      },
      Bug: {
        name: 'Bug',
        color: null,
        iconId: null,
        iconUrl: null,
        states: states([['Cut', 'Removed']])
      },
      Task: {
        name: 'Task',
        color: null,
        iconId: null,
        iconUrl: null,
        states: states([['Dropped', 'Removed']])
      }
    }
    expect(removedStateNames(LEVEL, metadata)).toEqual(['Removed', 'Cut'])
  })

  it('escapes a single quote in an area path', () => {
    const wiql = buildAzureDevOpsBoardWiql('Project', LEVEL, {
      field: null,
      defaultValue: "Project\\Ada's team",
      values: [{ value: "Project\\Ada's team", includeChildren: true }]
    })
    expect(wiql).toContain("UNDER 'Project\\Ada''s team'")
  })

  it('scopes the query by the team’s own field when it is a custom one', () => {
    const wiql = buildAzureDevOpsBoardWiql('Project', LEVEL, {
      field: 'Custom.TeamField',
      defaultValue: 'Contoso',
      values: [{ value: 'Contoso', includeChildren: true }]
    })
    expect(wiql).toContain("([Custom.TeamField] UNDER 'Contoso')")
    expect(wiql).not.toContain('System.AreaPath')
  })

  it('falls back to the area path when the host served no team field', () => {
    const wiql = buildAzureDevOpsBoardWiql('Project', LEVEL, {
      field: null,
      defaultValue: 'Project',
      values: [{ value: 'Project', includeChildren: false }]
    })
    expect(wiql).toContain("([System.AreaPath] = 'Project')")
  })

  it('matches a board to a level by name, ignoring case and surrounding space', () => {
    expect(resolveAzureDevOpsBoardForLevel([{ id: 'b1', name: ' backlog items ' }], LEVEL)).toEqual(
      { id: 'b1', name: ' backlog items ' }
    )
  })

  it('returns null when the level has no board', () => {
    expect(resolveAzureDevOpsBoardForLevel([{ id: 'b1', name: 'Epics' }], LEVEL)).toBeNull()
  })
})

describe('loadAzureDevOpsBoardPage', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat-token' }
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
    configClient.listAzureDevOpsBoards.mockResolvedValue([{ id: 'b1', name: 'Backlog items' }])
    configClient.getAzureDevOpsBoardConfiguration.mockResolvedValue(CONFIGURATION)
  })
  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
    vi.clearAllMocks()
  })

  it('hydrates every returned id across batches and keeps query order', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => 1000 - i)
    const { calls } = installAzureDevOpsFetchFixture({
      [TEAM]: AREAS,
      [WIQL]: { workItems: ids.map((id) => ({ id })) },
      [ITEMS]: itemsRoute()
    })
    const page = await loadAzureDevOpsBoardPage(CLOUD_REPO, 'Mobile', LEVEL)
    expect(calls.filter((c) => c.pathname === ITEMS)).toHaveLength(2)
    expect(page?.items.map((i) => i.id)).toEqual(ids)
  })

  it('posts the WIQL as a JSON query body', async () => {
    installAzureDevOpsFetchFixture({
      [TEAM]: AREAS,
      [WIQL]: { workItems: [] },
      [ITEMS]: itemsRoute()
    })
    await loadAzureDevOpsBoardPage(CLOUD_REPO, 'Mobile', LEVEL)
    const [, init] = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([u]) => String(u).includes('wiql'))!
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body)).query).toContain("UNDER 'Project'")
  })

  it('hydrates the board’s own column, row, done and card fields', async () => {
    const { calls } = installAzureDevOpsFetchFixture({
      [TEAM]: AREAS,
      [WIQL]: { workItems: [{ id: 1 }] },
      [ITEMS]: itemsRoute()
    })
    await loadAzureDevOpsBoardPage(CLOUD_REPO, 'Mobile', LEVEL)
    const fields = calls
      .find((c) => c.pathname === ITEMS)!
      .searchParams.get('fields')!
      .split(',')
    expect(fields).toEqual(
      expect.arrayContaining([
        'WEF_Board_Kanban.Column',
        'WEF_Board_Kanban.Lane',
        'WEF_Board_Kanban.Column.Done',
        'Microsoft.VSTS.Common.StackRank',
        'System.AssignedTo',
        'Custom.Severity'
      ])
    )
  })

  it('fetches the parents referenced by the loaded items', async () => {
    const { calls } = installAzureDevOpsFetchFixture({
      [TEAM]: AREAS,
      [WIQL]: { workItems: [{ id: 1 }] },
      [ITEMS]: itemsRoute({ 1: 7 })
    })
    const page = await loadAzureDevOpsBoardPage(CLOUD_REPO, 'Mobile', LEVEL)
    const requests = calls.filter((c) => c.pathname === ITEMS)
    expect(requests).toHaveLength(2)
    expect(requests[1].searchParams.get('ids')).toBe('7')
    expect(page?.parents.map((p) => p.id)).toEqual([7])
  })

  it('returns null when the team has no area values', async () => {
    installAzureDevOpsFetchFixture({
      [TEAM]: { field: { referenceName: 'System.AreaPath' }, defaultValue: 'Project', values: [] }
    })
    await expect(loadAzureDevOpsBoardPage(CLOUD_REPO, 'Mobile', LEVEL)).resolves.toBeNull()
  })

  it('returns the cards that loaded and counts the ones that did not', async () => {
    const ids = [1, 2, 3]
    installAzureDevOpsFetchFixture({
      [TEAM]: AREAS,
      [WIQL]: { workItems: ids.map((id) => ({ id })) },
      // Why: `errorPolicy: 'omit'` is how one deleted item comes back — the rest still arrive.
      [ITEMS]: (url: URL) => ({
        value: itemsRoute()(url).value.filter((item) => item.id !== 2)
      })
    })
    const page = await loadAzureDevOpsBoardPage(CLOUD_REPO, 'Mobile', LEVEL)
    expect(page?.items.map((i) => i.id)).toEqual([1, 3])
    expect(page?.unhydratedItemCount).toBe(1)
    expect(page?.unhydratedParentCount).toBe(0)
  })

  it('rejects when the card batch request itself fails', async () => {
    installAzureDevOpsFetchFixture({
      [TEAM]: AREAS,
      [WIQL]: { workItems: [{ id: 1 }] }
    })
    await expect(loadAzureDevOpsBoardPage(CLOUD_REPO, 'Mobile', LEVEL)).rejects.toThrow('HTTP 404')
  })

  it('counts off-board parents that could not be fetched instead of dropping them silently', async () => {
    installAzureDevOpsFetchFixture({
      [TEAM]: AREAS,
      [WIQL]: { workItems: [{ id: 1 }] },
      [ITEMS]: (url: URL) =>
        url.searchParams.get('ids') === '7' ? { value: [] } : itemsRoute({ 1: 7 })(url)
    })
    const page = await loadAzureDevOpsBoardPage(CLOUD_REPO, 'Mobile', LEVEL)
    expect(page?.items).toHaveLength(1)
    expect(page?.parents).toEqual([])
    expect(page?.unhydratedParentCount).toBe(1)
  })

  it('rejects when the board configuration cannot be read', async () => {
    configClient.getAzureDevOpsBoardConfiguration.mockResolvedValue(null)
    installAzureDevOpsFetchFixture({ [TEAM]: AREAS })
    await expect(loadAzureDevOpsBoardPage(CLOUD_REPO, 'Mobile', LEVEL)).rejects.toThrow(
      'configuration unavailable'
    )
  })

  it('rejects when the team area lookup fails', async () => {
    installAzureDevOpsFetchFixture({})
    await expect(loadAzureDevOpsBoardPage(CLOUD_REPO, 'Mobile', LEVEL)).rejects.toThrow('HTTP 404')
  })

  it('rejects when the team area response carries no values array', async () => {
    installAzureDevOpsFetchFixture({ [TEAM]: { defaultValue: 'Project' } })
    await expect(loadAzureDevOpsBoardPage(CLOUD_REPO, 'Mobile', LEVEL)).rejects.toThrow(
      'team field values unavailable'
    )
  })

  it('returns null when the level has no board, without querying work items', async () => {
    configClient.listAzureDevOpsBoards.mockResolvedValue([{ id: 'x', name: 'Unrelated' }])
    const { calls } = installAzureDevOpsFetchFixture({})
    await expect(loadAzureDevOpsBoardPage(CLOUD_REPO, 'Mobile', LEVEL)).resolves.toBeNull()
    expect(calls).toHaveLength(0)
  })
})
