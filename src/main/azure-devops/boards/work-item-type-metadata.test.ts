import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAzureDevOpsWorkItemTypes, removedStateNamesForTypes } from './work-item-type-metadata'
import {
  CLOUD_REPO,
  WORK_ITEM_TYPES_RESPONSE,
  installAzureDevOpsFetchFixture
} from './test-fixtures'

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch

describe('work item type metadata', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat-token' }
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
  })
  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
  })

  it('keys types by name and normalises colours to #rrggbb', async () => {
    installAzureDevOpsFetchFixture({
      '/acme/Project/_apis/wit/workitemtypes': WORK_ITEM_TYPES_RESPONSE
    })
    const types = await getAzureDevOpsWorkItemTypes(CLOUD_REPO)
    expect(types.Feature).toEqual({
      name: 'Feature',
      color: '#773B93',
      iconId: 'icon_trophy',
      iconUrl:
        'https://tfsprodcus3.visualstudio.com/_apis/wit/workItemIcons/icon_trophy?color=773B93&v=2',
      states: [
        { name: 'New', color: '#b2b2b2', category: 'Proposed' },
        { name: 'In Progress', color: '#007acc', category: 'InProgress' },
        { name: 'Done', color: '#339933', category: 'Completed' }
      ]
    })
    expect(Object.keys(types)).toEqual(['Feature', 'Product Backlog Item', 'Bug', 'Task'])
    // Why: on-prem responses may omit the url; the renderer then falls back to the lucide glyph.
    expect(types.Bug.iconUrl).toBeNull()
  })

  it('keeps a state name another type uses for active work out of the Removed list', () => {
    const types = {
      Bug: {
        name: 'Bug',
        color: null,
        iconId: null,
        iconUrl: null,
        states: [
          { name: 'Cut', color: null, category: 'Removed' as const },
          { name: 'Removed', color: null, category: 'Removed' as const }
        ]
      },
      Task: {
        name: 'Task',
        color: null,
        iconId: null,
        iconUrl: null,
        states: [{ name: 'Cut', color: null, category: 'InProgress' as const }]
      }
    }
    expect(removedStateNamesForTypes(['Bug', 'Task'], types)).toEqual(['Removed'])
    // The contested name is still excluded for a query that covers only the type that removes it.
    expect(removedStateNamesForTypes(['Bug'], types)).toEqual(['Cut', 'Removed'])
  })

  it('returns an empty map on failure', async () => {
    installAzureDevOpsFetchFixture({})
    await expect(getAzureDevOpsWorkItemTypes(CLOUD_REPO)).resolves.toEqual({})
  })
})
