import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AzureDevOpsBacklogLevel } from '../../../shared/azure-devops/boards-types'
import {
  getAzureDevOpsBacklogViewSettings,
  mapAzureDevOpsBacklogViewSettings,
  parseAzureDevOpsColumnOptions,
  parseAzureDevOpsSavedFilter
} from './backlog-view-settings-client'
import {
  BACKLOG_HUB_SETTINGS_RESPONSE,
  BACKLOG_SAVED_FILTERS_RESPONSE,
  CLOUD_REPO,
  installAzureDevOpsFetchFixture
} from './test-fixtures'

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch
const ENTRIES = '/acme/_apis/Settings/WebTeam/team-2/Entries/me'

function level(
  id: string,
  name: string,
  kind: AzureDevOpsBacklogLevel['kind']
): AzureDevOpsBacklogLevel {
  return { id, name, rank: 1, kind, workItemTypes: [], columnFields: [], hidden: false }
}
const LEVELS = [
  level('Microsoft.FeatureCategory', 'Features', 'portfolio'),
  level('Microsoft.RequirementCategory', 'Backlog items', 'requirement')
]

describe('parseAzureDevOpsColumnOptions', () => {
  it('normalises current and legacy entries on name and drops rollups', () => {
    expect(
      parseAzureDevOpsColumnOptions(
        BACKLOG_HUB_SETTINGS_RESPONSE.value['ColumnOptions/Microsoft.FeatureCategory']
      )
    ).toEqual([
      { referenceName: 'System.WorkItemType', name: 'Work Item Type', width: 100 },
      { referenceName: 'System.Title', name: 'Title', width: 400 },
      { referenceName: 'System.AreaPath', name: 'Area Path', width: 178 },
      { referenceName: 'System.Parent', name: 'Parent', width: 200 }
    ])
  })

  it('returns nothing for malformed or non-string values', () => {
    expect(parseAzureDevOpsColumnOptions('{not json')).toEqual([])
    expect(parseAzureDevOpsColumnOptions(42)).toEqual([])
    expect(parseAzureDevOpsColumnOptions(JSON.stringify([{ text: 'no name' }]))).toEqual([])
  })
})

describe('parseAzureDevOpsSavedFilter', () => {
  it('maps the known field keys, the keyword and ignores unknown keys', () => {
    expect(
      parseAzureDevOpsSavedFilter(BACKLOG_SAVED_FILTERS_RESPONSE.value['Backlog items/Filter'])
    ).toEqual({
      keyword: 'login',
      workItemTypes: ['Bug'],
      assignedTo: ['Ada Lovelace'],
      states: [],
      areaPaths: [],
      iterationPaths: [],
      tags: ['urgent']
    })
  })

  it('returns null for a non-JSON value', () => {
    expect(parseAzureDevOpsSavedFilter('nope')).toBeNull()
  })
})

describe('mapAzureDevOpsBacklogViewSettings', () => {
  it('maps the legacy requirement key and filter level names to level ids', () => {
    const settings = mapAzureDevOpsBacklogViewSettings(
      BACKLOG_HUB_SETTINGS_RESPONSE.value,
      BACKLOG_SAVED_FILTERS_RESPONSE.value,
      LEVELS
    )
    expect(Object.keys(settings.columnOptionsByLevel)).toEqual([
      'Microsoft.FeatureCategory',
      'Microsoft.RequirementCategory'
    ])
    expect(
      settings.columnOptionsByLevel['Microsoft.RequirementCategory'].map((c) => c.referenceName)
    ).toEqual(['System.Title', 'System.State', 'System.Parent', 'System.Tags'])
    expect(settings.showParents).toBe(true)
    expect(settings.inProgressFilter).toBe(false)
    expect(Object.keys(settings.savedFiltersByLevel)).toEqual(['Microsoft.RequirementCategory'])
  })

  it('leaves booleans null and ignores filters for unknown levels when the user saved nothing', () => {
    const settings = mapAzureDevOpsBacklogViewSettings(
      { 'ColumnOptions/ProductBacklogColumnOptions': '[]' },
      { 'Gone/Filter': '{}' },
      LEVELS
    )
    expect(settings).toEqual({
      columnOptionsByLevel: {},
      showParents: null,
      inProgressFilter: null,
      savedFiltersByLevel: {}
    })
  })
})

describe('getAzureDevOpsBacklogViewSettings', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'local-pat' }
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
    vi.restoreAllMocks()
  })

  it('reads both entry sets at the collection root with the preview api version', async () => {
    const { calls } = installAzureDevOpsFetchFixture({
      [`${ENTRIES}/Agile/BacklogsHub`]: BACKLOG_HUB_SETTINGS_RESPONSE,
      [`${ENTRIES}/Backlogs/backlog`]: BACKLOG_SAVED_FILTERS_RESPONSE
    })
    const settings = await getAzureDevOpsBacklogViewSettings(CLOUD_REPO, 'team-2', LEVELS)
    expect(settings?.showParents).toBe(true)
    expect(settings?.savedFiltersByLevel['Microsoft.RequirementCategory']?.keyword).toBe('login')
    expect(calls.map((u) => `${u.pathname}?${u.searchParams.get('api-version')}`)).toEqual([
      `${ENTRIES}/Agile/BacklogsHub?7.1-preview.1`,
      `${ENTRIES}/Backlogs/backlog?7.1-preview.1`
    ])
  })

  it('falls back to null (one warning) when the hub call is unauthorised', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a 401 Response is all the client reads; vi.fn's return type lacks fetch's preconnect member.
    globalThis.fetch = vi.fn(async () => new Response('', { status: 401 })) as never
    await expect(
      getAzureDevOpsBacklogViewSettings(CLOUD_REPO, 'team-2', LEVELS)
    ).resolves.toBeNull()
    await expect(
      getAzureDevOpsBacklogViewSettings(CLOUD_REPO, 'team-2', LEVELS)
    ).resolves.toBeNull()
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('still returns hub settings when only the saved-filter entries are missing', async () => {
    installAzureDevOpsFetchFixture({
      [`${ENTRIES}/Agile/BacklogsHub`]: { count: 1, value: { ShowParentsFilter: false } }
    })
    const settings = await getAzureDevOpsBacklogViewSettings(CLOUD_REPO, 'team-2', LEVELS)
    expect(settings).toEqual({
      columnOptionsByLevel: {},
      showParents: false,
      inProgressFilter: null,
      savedFiltersByLevel: {}
    })
  })
})
