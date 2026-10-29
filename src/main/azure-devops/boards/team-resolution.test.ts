import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listAzureDevOpsIterations, listAzureDevOpsTeams } from './team-resolution'
import {
  CLOUD_REPO,
  ITERATIONS_RESPONSE,
  PROJECT_RESPONSE,
  TEAMS_RESPONSE,
  installAzureDevOpsFetchFixture
} from './test-fixtures'

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch

describe('team resolution', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat-token' }
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
  })
  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
  })

  it('lists teams and marks the project default', async () => {
    installAzureDevOpsFetchFixture({
      '/acme/_apis/projects/Project/teams': TEAMS_RESPONSE,
      '/acme/_apis/projects/Project': PROJECT_RESPONSE
    })
    await expect(listAzureDevOpsTeams(CLOUD_REPO)).resolves.toEqual([
      { id: 'team-1', name: 'Platform', isDefault: false },
      { id: 'team-2', name: 'Mobile', isDefault: true }
    ])
  })

  it('lists iterations with their time frame and dates', async () => {
    installAzureDevOpsFetchFixture({
      '/acme/Project/Mobile/_apis/work/teamsettings/iterations': ITERATIONS_RESPONSE
    })
    await expect(listAzureDevOpsIterations(CLOUD_REPO, 'Mobile')).resolves.toEqual([
      {
        id: 'it-1',
        name: '2026',
        path: 'Project\\2026',
        timeFrame: 'current',
        startDate: '2026-07-01T00:00:00Z',
        finishDate: '2026-12-01T00:00:00Z'
      },
      {
        id: 'it-0',
        name: 'Backlog',
        path: 'Project',
        timeFrame: null,
        startDate: null,
        finishDate: null
      }
    ])
  })

  it('throws with the HTTP status when the team list request fails', async () => {
    installAzureDevOpsFetchFixture({})
    await expect(listAzureDevOpsTeams(CLOUD_REPO)).rejects.toThrow('HTTP 404')
  })

  it('keeps the team list with no default when only the project lookup fails', async () => {
    installAzureDevOpsFetchFixture({
      '/acme/_apis/projects/Project/teams': TEAMS_RESPONSE
    })
    await expect(listAzureDevOpsTeams(CLOUD_REPO)).resolves.toEqual([
      { id: 'team-1', name: 'Platform', isDefault: false },
      { id: 'team-2', name: 'Mobile', isDefault: false }
    ])
  })
})
