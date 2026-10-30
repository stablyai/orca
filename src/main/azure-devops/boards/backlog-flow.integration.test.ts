import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AzureDevOpsAssignedWorkItemsPage,
  AzureDevOpsBacklogPage,
  AzureDevOpsTeam,
  AzureDevOpsTeamConfiguration,
  AzureDevOpsWorkItemDetail
} from '../../../shared/azure-devops/boards-types'
import type { Repo } from '../../../shared/repo-types'
import type { Store } from '../../persistence'
import { _resetAzureDevOpsRepoRefCache } from '../repository-ref'
import {
  BACKLOG_CONFIGURATION_RESPONSE,
  BACKLOG_HUB_SETTINGS_RESPONSE,
  BACKLOG_SAVED_FILTERS_RESPONSE,
  ITERATIONS_RESPONSE,
  PROJECT_RESPONSE,
  TEAMS_RESPONSE,
  WORK_ITEM_TYPES_RESPONSE,
  installAzureDevOpsFetchFixture,
  rawWorkItem
} from './test-fixtures'

// Why: exercised through the IPC handlers so repo resolution, auth, routing and
// every client run as the renderer drives them; only Electron's ipcMain is faked.
const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, fn)
  }
}))

import { registerAzureDevOpsBoardsHandlers } from '../../ipc/azure-devops-boards'

const execFileAsync = promisify(execFile)
const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch

const WIT = '/acme/Project/_apis/wit'
// Why: the team list carries ids, so every team-scoped route is taken by id, not name.
const TEAM = '/acme/Project/team-2/_apis/work'
const USER_SETTINGS = '/acme/_apis/Settings/WebTeam/team-2/Entries/me'

function pbi(id: number, parent: number | null, rank: number) {
  return rawWorkItem(id, {
    'System.WorkItemType': 'Product Backlog Item',
    'System.Title': `PBI ${id}`,
    'System.State': 'Approved',
    'System.Parent': parent,
    'Microsoft.VSTS.Common.StackRank': rank,
    'System.Description': '<div>Do <b>it</b></div>'
  })
}

const POOL: Record<number, ReturnType<typeof rawWorkItem>> = {
  10: pbi(10, 70, 1),
  11: pbi(11, null, 2),
  101: rawWorkItem(101, {
    'System.WorkItemType': 'Task',
    'System.Title': 'Task 101',
    'System.State': 'To Do',
    'System.Parent': 10,
    'Microsoft.VSTS.Common.StackRank': 5
  }),
  70: rawWorkItem(70, {
    'System.WorkItemType': 'Feature',
    'System.Title': 'Feature 70',
    'System.State': 'In Progress'
  })
}

describe('Azure DevOps backlog flow integration', () => {
  let repoPath: string
  let store: Store

  beforeEach(async () => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'local-pat' }
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
    _resetAzureDevOpsRepoRefCache()
    handlers.clear()
    repoPath = await mkdtemp(join(tmpdir(), 'orca-azure-backlog-'))
    await execFileAsync('git', ['init'], { cwd: repoPath })
    await execFileAsync(
      'git',
      ['remote', 'add', 'origin', 'https://dev.azure.com/acme/Project/_git/repo'],
      { cwd: repoPath }
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the boards clients read only id and path off the repo.
    const repo = { id: 'repo-1', path: repoPath } as Repo
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only the four store members stubbed here.
    store = {
      getRepo: (id: string) => (id === repo.id ? repo : undefined),
      getRepos: () => [repo],
      getProjects: () => [],
      getSettings: () => ({})
    } as unknown as Store
    registerAzureDevOpsBoardsHandlers(store)
  })

  afterEach(async () => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
    _resetAzureDevOpsRepoRefCache()
    await rm(repoPath, { recursive: true, force: true })
  })

  it('walks auth → teams → configuration → backlog → detail against one fixture', async () => {
    const { calls } = installAzureDevOpsFetchFixture({
      '/acme/_apis/projects/Project/teams': TEAMS_RESPONSE,
      '/acme/_apis/projects/Project': PROJECT_RESPONSE,
      [`${TEAM}/backlogconfiguration`]: BACKLOG_CONFIGURATION_RESPONSE,
      [`${TEAM}/teamsettings/iterations`]: ITERATIONS_RESPONSE,
      [`${WIT}/workitemtypes`]: WORK_ITEM_TYPES_RESPONSE,
      [`${USER_SETTINGS}/Agile/BacklogsHub`]: BACKLOG_HUB_SETTINGS_RESPONSE,
      [`${USER_SETTINGS}/Backlogs/backlog`]: BACKLOG_SAVED_FILTERS_RESPONSE,
      [`${TEAM}/backlogs/Microsoft.RequirementCategory/workItems`]: {
        workItems: [{ target: { id: 10 } }, { target: { id: 11 } }]
      },
      [`${WIT}/workitems`]: (url: URL) => ({
        value: (url.searchParams.get('ids') ?? '')
          .split(',')
          .map(Number)
          .map((id) => POOL[id])
          .filter(Boolean)
      }),
      [`${WIT}/wiql`]: {
        workItemRelations: [
          { rel: 'System.LinkTypes.Hierarchy-Forward', source: { id: 10 }, target: { id: 101 } }
        ]
      },
      [`${WIT}/workitems/10`]: {
        ...POOL[10],
        relations: [
          {
            rel: 'System.LinkTypes.Hierarchy-Reverse',
            url: `https://dev.azure.com/acme/_apis/wit/workItems/70`
          },
          {
            rel: 'System.LinkTypes.Hierarchy-Forward',
            url: `https://dev.azure.com/acme/_apis/wit/workItems/101`
          },
          {
            rel: 'ArtifactLink',
            url: 'vstfs:///Git/PullRequestId/proj-guid%2Frepo-guid%2F171',
            attributes: { name: 'Pull Request' }
          }
        ]
      }
    })
    const repoArgs = { repoPath, repoId: 'repo-1', connectionId: null }

    await expect(handlers.get('azureDevOpsBoards:isAuthenticated')!({}, repoArgs)).resolves.toBe(
      true
    )

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler registered for this channel returns the listTeams result.
    const teams = (await handlers.get('azureDevOpsBoards:listTeams')!(
      {},
      repoArgs
    )) as AzureDevOpsTeam[]
    expect(teams).toEqual([
      { id: 'team-1', name: 'Platform', isDefault: false },
      { id: 'team-2', name: 'Mobile', isDefault: true }
    ])
    const team = teams.find((t) => t.isDefault)!
    const teamRoute = { teamName: team.name, teamId: team.id }

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler registered for this channel returns the configuration bundle.
    const configuration = (await handlers.get('azureDevOpsBoards:getConfiguration')!(
      {},
      {
        ...repoArgs,
        ...teamRoute
      }
    )) as AzureDevOpsTeamConfiguration
    expect(configuration.repo).toEqual({ organization: 'acme', project: 'Project' })
    expect(configuration.backlog?.bugsBehavior).toBe('asRequirements')
    expect(configuration.backlog?.levels.map((l) => [l.id, l.hidden])).toEqual([
      ['Microsoft.EpicCategory', true],
      ['Microsoft.FeatureCategory', false],
      ['Microsoft.RequirementCategory', false],
      ['Microsoft.TaskCategory', false]
    ])
    expect(configuration.iterations.map((i) => i.timeFrame)).toEqual(['current', null])
    expect(configuration.workItemTypes.Feature.iconUrl).toContain('workItemIcons/icon_trophy')
    expect(configuration.viewSettings).toMatchObject({
      showParents: true,
      inProgressFilter: false,
      savedFiltersByLevel: { 'Microsoft.RequirementCategory': { keyword: 'login' } }
    })
    expect(
      configuration.viewSettings?.columnOptionsByLevel['Microsoft.RequirementCategory'].map(
        (c) => c.referenceName
      )
    ).toEqual(['System.Title', 'System.State', 'System.Parent', 'System.Tags'])
    const level = configuration.backlog!.levels.find((l) => l.kind === 'requirement')!

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler registered for this channel returns the backlog page.
    const page = (await handlers.get('azureDevOpsBoards:loadBacklog')!(
      {},
      {
        ...repoArgs,
        ...teamRoute,
        level
      }
    )) as AzureDevOpsBacklogPage
    expect(page.items.map((i) => i.id)).toEqual([10, 11])
    expect(page.childrenByParent).toEqual({ 10: [101], 11: [] })
    expect(page.parents.map((p) => p.id)).toEqual([70])
    expect(page.items[0].url).toBe('https://dev.azure.com/acme/Project/_workitems/edit/10')

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler registered for this channel returns the work item detail.
    const detail = (await handlers.get('azureDevOpsBoards:getWorkItem')!(
      {},
      {
        ...repoArgs,
        id: 10
      }
    )) as AzureDevOpsWorkItemDetail
    expect(detail).toMatchObject({
      id: 10,
      parentId: 70,
      childIds: [101],
      // The caller named no cached ids, so the child comes back with the detail.
      children: [expect.objectContaining({ id: 101 })],
      descriptionHtml: '<div>Do <b>it</b></div>',
      pullRequestLinks: [
        { id: 171, url: 'https://dev.azure.com/acme/proj-guid/_git/repo-guid/pullrequest/171' }
      ]
    })

    expect(calls.map((u) => u.pathname)).toEqual([
      '/acme/_apis/projects/Project/teams',
      '/acme/_apis/projects/Project',
      `${TEAM}/backlogconfiguration`,
      `${TEAM}/teamsettings/iterations`,
      `${WIT}/workitemtypes`,
      `${USER_SETTINGS}/Agile/BacklogsHub`,
      `${USER_SETTINGS}/Backlogs/backlog`,
      `${TEAM}/backlogs/Microsoft.RequirementCategory/workItems`,
      `${WIT}/workitems`,
      `${WIT}/wiql`,
      `${WIT}/workitems`,
      `${WIT}/workitems`,
      `${WIT}/workitems/10`,
      `${WIT}/workitems`
    ])
  })

  it('loads the Work items view with no team route at all', async () => {
    const { calls } = installAzureDevOpsFetchFixture({
      '/acme/_apis/projects/Project': PROJECT_RESPONSE,
      [`${WIT}/workitemtypes`]: WORK_ITEM_TYPES_RESPONSE,
      [`${WIT}/wiql`]: { workItems: [{ id: 11 }, { id: 10 }] },
      [`${WIT}/workitems`]: (url: URL) => ({
        value: (url.searchParams.get('ids') ?? '')
          .split(',')
          .map(Number)
          .map((id) => POOL[id])
          .filter(Boolean)
      })
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler registered for this channel returns the assigned work items page.
    const page = (await handlers.get('azureDevOpsBoards:loadAssignedWorkItems')!(
      {},
      { repoPath, repoId: 'repo-1', connectionId: null }
    )) as AzureDevOpsAssignedWorkItemsPage
    expect(page.items.map((i) => i.id)).toEqual([11, 10])
    expect(page.unhydratedItemCount).toBe(0)
    // No team-scoped route is touched: this view is project-wide.
    expect(calls.every((u) => !u.pathname.includes('/team-'))).toBe(true)
    const body = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([input]) => new URL(String(input)).pathname === `${WIT}/wiql`)?.[1]?.body
    expect(String(body)).toContain('[System.AssignedTo] = @Me')
    expect(String(body)).toContain('ORDER BY [System.ChangedDate] DESC')
  })

  it('reports a repo whose remote is not Azure DevOps before any HTTP call', async () => {
    const { calls } = installAzureDevOpsFetchFixture({})
    await execFileAsync(
      'git',
      ['remote', 'set-url', 'origin', 'https://github.com/acme/repo.git'],
      { cwd: repoPath }
    )
    await expect(
      handlers.get('azureDevOpsBoards:listTeams')!({}, { repoPath, repoId: 'repo-1' })
    ).rejects.toThrow('azure_devops_remote_required')
    expect(calls).toHaveLength(0)
  })
})
