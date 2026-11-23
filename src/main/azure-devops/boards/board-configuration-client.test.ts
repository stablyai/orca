import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getAzureDevOpsBacklogConfiguration,
  getAzureDevOpsBoardConfiguration,
  listAzureDevOpsBoards
} from './board-configuration-client'
import {
  BACKLOG_CONFIGURATION_RESPONSE,
  CLOUD_REPO,
  installAzureDevOpsFetchFixture
} from './test-fixtures'

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch
const TEAM = '/acme/Project/Mobile/_apis/work'

const BOARD_RESPONSE = {
  id: 'board-1',
  name: 'Features',
  columns: [
    {
      id: 'c1',
      name: 'New',
      columnType: 'incoming',
      itemLimit: 0,
      isSplit: null,
      stateMappings: { Feature: 'New' },
      description: null
    },
    {
      id: 'c2',
      name: 'In Progress',
      columnType: 'inProgress',
      itemLimit: 5,
      isSplit: false,
      stateMappings: { Feature: 'In Progress' },
      description: ''
    },
    {
      id: 'c3',
      name: 'PM Review',
      columnType: 'inProgress',
      itemLimit: 5,
      isSplit: true,
      stateMappings: { Feature: 'In Progress' },
      description: ''
    },
    {
      id: 'c4',
      name: 'Done',
      columnType: 'outgoing',
      itemLimit: 0,
      isSplit: null,
      stateMappings: { Feature: 'Done' },
      description: null
    }
  ],
  rows: [
    { id: 'r1', name: 'Platform', color: null },
    { id: '00000000-0000-0000-0000-000000000000', name: 'Uncategorized', color: null }
  ],
  fields: {
    columnField: { referenceName: 'WEF_ABC_Kanban.Column' },
    rowField: { referenceName: 'WEF_ABC_Kanban.Lane' },
    doneField: { referenceName: 'WEF_ABC_Kanban.Column.Done' }
  }
}
const ROWS_RESPONSE = {
  value: [
    { id: 'r1', name: 'Platform', color: '#F599D1' },
    { id: '00000000-0000-0000-0000-000000000000', name: 'Uncategorized', color: null }
  ]
}
const CARD_SETTINGS_RESPONSE = {
  cards: {
    Feature: [
      { displayType: 'CORE', fieldIdentifier: 'System.AssignedTo' },
      { displayType: 'CORE', fieldIdentifier: 'System.Id' },
      { showEmptyFields: 'true' },
      { fieldIdentifier: 'System.State' },
      { fieldIdentifier: 'System.Title' }
    ]
  }
}
const CARD_RULES_RESPONSE = {
  rules: {
    fill: [
      {
        name: 'Blocked',
        isEnabled: 'true',
        filter: "[System.Tags] contains 'blocked'",
        clauses: [
          {
            fieldName: 'System.Tags',
            index: 0,
            logicalOperator: '',
            operator: 'contains',
            value: 'blocked'
          }
        ],
        settings: { 'background-color': '#FBBC3D', 'title-color': '#000000' }
      },
      {
        name: 'Lowercase enabled',
        isEnabled: 'true',
        clauses: [
          {
            fieldName: 'Microsoft.VSTS.Common.Priority',
            index: 1,
            logicalOperator: 'Or',
            operator: '<=',
            value: '2'
          },
          {
            fieldName: 'System.State',
            index: 0,
            logicalOperator: '',
            operator: 'Does Not Contain',
            value: 'Done'
          }
        ],
        settings: { 'background-color': '#E5F2FF' }
      },
      {
        name: 'Disabled',
        isEnabled: 'False',
        clauses: [
          { fieldName: 'System.State', index: 0, logicalOperator: '', operator: '=', value: 'New' }
        ],
        settings: { 'background-color': '#000000' }
      },
      {
        name: 'No colour',
        isEnabled: 'True',
        clauses: [
          { fieldName: 'System.State', index: 0, logicalOperator: '', operator: '=', value: 'New' }
        ],
        settings: {}
      },
      {
        name: 'No clauses',
        isEnabled: 'True',
        clauses: [],
        settings: { 'background-color': '#111111' }
      }
    ],
    tagStyle: [
      { isEnabled: 'True', name: 'triage', settings: { 'background-color': '#797775' } },
      { isEnabled: 'true', name: 'ready', settings: { 'background-color': '#5FB65F' } },
      { isEnabled: 'False', name: 'ignored', settings: { 'background-color': '#000000' } }
    ]
  }
}

describe('board configuration client', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat-token' }
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
  })
  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
  })

  it('maps backlog levels by rank, keeps hidden levels flagged and reads bugsBehavior', async () => {
    installAzureDevOpsFetchFixture({
      [`${TEAM}/backlogconfiguration`]: BACKLOG_CONFIGURATION_RESPONSE
    })
    const config = await getAzureDevOpsBacklogConfiguration(CLOUD_REPO, 'Mobile')
    expect(config?.bugsBehavior).toBe('asRequirements')
    expect(config?.levels.map((l) => [l.id, l.name, l.rank, l.kind, l.hidden])).toEqual([
      ['Microsoft.EpicCategory', 'Epics', 4, 'portfolio', true],
      ['Microsoft.FeatureCategory', 'Features', 3, 'portfolio', false],
      ['Microsoft.RequirementCategory', 'Backlog items', 2, 'requirement', false],
      ['Microsoft.TaskCategory', 'Tasks', 1, 'task', false]
    ])
    expect(config?.levels[2].workItemTypes).toEqual(['Product Backlog Item', 'Bug'])
    expect(config?.levels[2].columnFields.map((c) => c.referenceName)).toEqual([
      'System.WorkItemType',
      'System.Title',
      'System.State',
      'Microsoft.VSTS.Scheduling.Effort',
      'System.IterationPath',
      'System.Tags'
    ])
    expect(config?.levels[2].columnFields[1]).toEqual({
      referenceName: 'System.Title',
      name: 'Title',
      width: 400
    })
  })

  it('lists boards', async () => {
    installAzureDevOpsFetchFixture({
      [`${TEAM}/boards`]: { value: [{ id: 'board-1', name: 'Features' }] }
    })
    await expect(listAzureDevOpsBoards(CLOUD_REPO, 'Mobile')).resolves.toEqual([
      { id: 'board-1', name: 'Features' }
    ])
  })

  it('assembles a board from the board, rows, cardsettings and cardrulesettings endpoints', async () => {
    installAzureDevOpsFetchFixture({
      [`${TEAM}/boards/board-1`]: BOARD_RESPONSE,
      [`${TEAM}/boards/board-1/rows`]: ROWS_RESPONSE,
      [`${TEAM}/boards/board-1/cardsettings`]: CARD_SETTINGS_RESPONSE,
      [`${TEAM}/boards/board-1/cardrulesettings`]: CARD_RULES_RESPONSE
    })
    const board = await getAzureDevOpsBoardConfiguration(CLOUD_REPO, 'Mobile', 'board-1')
    expect(board?.columns.map((c) => [c.name, c.columnType, c.itemLimit, c.isSplit])).toEqual([
      ['New', 'incoming', 0, false],
      ['In Progress', 'inProgress', 5, false],
      ['PM Review', 'inProgress', 5, true],
      ['Done', 'outgoing', 0, false]
    ])
    // Why: colours only exist on /rows; the embedded rows carry null.
    expect(board?.rows).toEqual([
      { id: 'r1', name: 'Platform', color: '#F599D1', isDefault: false },
      {
        id: '00000000-0000-0000-0000-000000000000',
        name: 'Uncategorized',
        color: null,
        isDefault: true
      }
    ])
    expect(board?.columnField).toBe('WEF_ABC_Kanban.Column')
    expect(board?.rowField).toBe('WEF_ABC_Kanban.Lane')
    expect(board?.doneField).toBe('WEF_ABC_Kanban.Column.Done')
    expect(board?.cardFields.Feature).toEqual({
      showEmptyFields: true,
      fields: [
        { referenceName: 'System.AssignedTo', core: true },
        { referenceName: 'System.Id', core: true },
        { referenceName: 'System.State', core: false },
        { referenceName: 'System.Title', core: false }
      ]
    })
    expect(board?.tagColors).toEqual({ triage: '#797775', ready: '#5FB65F' })
    expect(board?.styleRules).toEqual([
      {
        name: 'Blocked',
        clauses: [
          {
            fieldName: 'System.Tags',
            operator: 'contains',
            value: 'blocked',
            logicalOperator: null
          }
        ],
        backgroundColor: '#FBBC3D',
        titleColor: '#000000'
      },
      {
        name: 'Lowercase enabled',
        clauses: [
          {
            fieldName: 'System.State',
            operator: 'does not contain',
            value: 'Done',
            logicalOperator: null
          },
          {
            fieldName: 'Microsoft.VSTS.Common.Priority',
            operator: '<=',
            value: '2',
            logicalOperator: 'or'
          }
        ],
        backgroundColor: '#E5F2FF',
        titleColor: null
      }
    ])
  })

  it('returns null when the backlog configuration request fails', async () => {
    installAzureDevOpsFetchFixture({})
    await expect(getAzureDevOpsBacklogConfiguration(CLOUD_REPO, 'Mobile')).resolves.toBeNull()
  })

  it('degrades to no rows when the rows endpoint fails but keeps columns and card settings', async () => {
    installAzureDevOpsFetchFixture({
      [`${TEAM}/boards/board-1`]: BOARD_RESPONSE,
      [`${TEAM}/boards/board-1/cardsettings`]: CARD_SETTINGS_RESPONSE,
      [`${TEAM}/boards/board-1/cardrulesettings`]: CARD_RULES_RESPONSE
    })
    const board = await getAzureDevOpsBoardConfiguration(CLOUD_REPO, 'Mobile', 'board-1')
    expect(board?.rows).toEqual([])
    expect(board?.columns.map((c) => c.name)).toEqual(['New', 'In Progress', 'PM Review', 'Done'])
    expect(board?.cardFields.Feature?.fields.length).toBe(4)
  })

  it('returns null when the board itself cannot be read', async () => {
    installAzureDevOpsFetchFixture({
      [`${TEAM}/boards/board-1/rows`]: ROWS_RESPONSE,
      [`${TEAM}/boards/board-1/cardsettings`]: CARD_SETTINGS_RESPONSE,
      [`${TEAM}/boards/board-1/cardrulesettings`]: CARD_RULES_RESPONSE
    })
    await expect(
      getAzureDevOpsBoardConfiguration(CLOUD_REPO, 'Mobile', 'board-1')
    ).resolves.toBeNull()
  })
})
