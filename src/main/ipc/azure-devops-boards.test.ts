import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, fn)
  }
}))

const getAzureDevOpsRepoRef = vi.hoisted(() => vi.fn())
const listAzureDevOpsTeams = vi.hoisted(() => vi.fn())
const loadAzureDevOpsBacklogPage = vi.hoisted(() => vi.fn())
const getAzureDevOpsBacklogConfiguration = vi.hoisted(() => vi.fn(async () => null))
const getAzureDevOpsBacklogViewSettings = vi.hoisted(() => vi.fn(async () => null))
const isAzureDevOpsReviewCreationAuthenticated = vi.hoisted(() => vi.fn(async () => true))
const getLocalProjectWorktreeGitOptions = vi.hoisted(() => vi.fn(() => ({})))
vi.mock('../azure-devops/repository-ref', () => ({ getAzureDevOpsRepoRef }))
vi.mock('../azure-devops/boards/team-resolution', () => ({
  listAzureDevOpsTeams,
  listAzureDevOpsIterations: vi.fn(async () => [])
}))
vi.mock('../azure-devops/boards/backlog-client', () => ({ loadAzureDevOpsBacklogPage }))
vi.mock('../azure-devops/boards/board-configuration-client', () => ({
  getAzureDevOpsBacklogConfiguration
}))
vi.mock('../azure-devops/boards/backlog-view-settings-client', () => ({
  getAzureDevOpsBacklogViewSettings
}))
vi.mock('../azure-devops/boards/work-item-type-metadata', () => ({
  getAzureDevOpsWorkItemTypes: vi.fn(async () => ({}))
}))
vi.mock('../azure-devops/boards/work-item-client', () => ({
  getAzureDevOpsWorkItemDetail: vi.fn(async () => null)
}))
vi.mock('../azure-devops/pull-request-creation', () => ({
  isAzureDevOpsReviewCreationAuthenticated
}))
vi.mock('../project-runtime-git-options', () => ({ getLocalProjectWorktreeGitOptions }))

import { registerAzureDevOpsBoardsHandlers } from './azure-devops-boards'
import type { Store } from '../persistence'

const REPO = {
  host: 'dev.azure.com',
  organization: 'acme',
  project: 'Project',
  repository: 'repo',
  apiBaseUrl: 'https://dev.azure.com/acme/Project',
  webBaseUrl: 'https://dev.azure.com/acme/Project/_git/repo'
}
const registeredRepo = { id: 'repo-1', path: '/repo', connectionId: null }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only getRepo and getRepos off the store.
const store = {
  getRepo: (id: string) => (id === registeredRepo.id ? registeredRepo : undefined),
  getRepos: () => [registeredRepo]
} as unknown as Store

describe('azure-devops boards ipc', () => {
  beforeEach(() => {
    handlers.clear()
    getAzureDevOpsRepoRef.mockReset()
    listAzureDevOpsTeams.mockReset()
    loadAzureDevOpsBacklogPage.mockReset()
    getAzureDevOpsBacklogConfiguration.mockReset()
    getAzureDevOpsBacklogConfiguration.mockResolvedValue(null)
    getAzureDevOpsBacklogViewSettings.mockReset()
    getAzureDevOpsBacklogViewSettings.mockResolvedValue(null)
    isAzureDevOpsReviewCreationAuthenticated.mockClear()
    getLocalProjectWorktreeGitOptions.mockReset()
    getLocalProjectWorktreeGitOptions.mockReturnValue({})
    registerAzureDevOpsBoardsHandlers(store)
  })

  it('resolves the repo ref from the path and lists teams', async () => {
    getAzureDevOpsRepoRef.mockResolvedValue(REPO)
    listAzureDevOpsTeams.mockResolvedValue([{ id: 't', name: 'Mobile', isDefault: true }])
    const result = await handlers.get('azureDevOpsBoards:listTeams')!(
      {},
      { repoPath: '/repo', repoId: 'repo-1', connectionId: null }
    )
    expect(getAzureDevOpsRepoRef).toHaveBeenCalledWith('/repo', null, {})
    expect(result).toEqual([{ id: 't', name: 'Mobile', isDefault: true }])
  })

  it('threads the WSL distro of a registered local project into the remote probe', async () => {
    getLocalProjectWorktreeGitOptions.mockReturnValue({ wslDistro: 'Ubuntu' })
    getAzureDevOpsRepoRef.mockResolvedValue(REPO)
    listAzureDevOpsTeams.mockResolvedValue([])
    await handlers.get('azureDevOpsBoards:listTeams')!({}, { repoPath: '/repo', repoId: 'repo-1' })
    expect(getLocalProjectWorktreeGitOptions).toHaveBeenCalledWith(store, registeredRepo)
    expect(getAzureDevOpsRepoRef).toHaveBeenCalledWith('/repo', null, { wslDistro: 'Ubuntu' })
  })

  it('resolves the repo before probing auth and passes the local git options through', async () => {
    getLocalProjectWorktreeGitOptions.mockReturnValue({ wslDistro: 'Ubuntu' })
    getAzureDevOpsRepoRef.mockResolvedValue(REPO)
    await expect(
      handlers.get('azureDevOpsBoards:isAuthenticated')!(
        {},
        { repoPath: '/repo', repoId: 'repo-1' }
      )
    ).resolves.toBe(true)
    expect(isAzureDevOpsReviewCreationAuthenticated).toHaveBeenCalledWith('/repo', null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })
  })

  it('reports a non Azure DevOps local repo as remote_required on every handler', async () => {
    getAzureDevOpsRepoRef.mockResolvedValue(null)
    for (const channel of [
      'azureDevOpsBoards:isAuthenticated',
      'azureDevOpsBoards:listTeams',
      'azureDevOpsBoards:getConfiguration',
      'azureDevOpsBoards:loadBacklog',
      'azureDevOpsBoards:getWorkItem'
    ]) {
      await expect(
        handlers.get(channel)!(
          {},
          { repoPath: '/repo', teamName: 'Mobile', level: { id: 'x' }, id: 1 }
        )
      ).rejects.toThrow('azure_devops_remote_required')
    }
    expect(listAzureDevOpsTeams).not.toHaveBeenCalled()
    expect(isAzureDevOpsReviewCreationAuthenticated).not.toHaveBeenCalled()
  })

  it('never calls a null probe on a remote host "no remote": it is unverifiable', async () => {
    getAzureDevOpsRepoRef.mockResolvedValue(null)
    await expect(
      handlers.get('azureDevOpsBoards:listTeams')!(
        {},
        { repoPath: '/srv/repo', connectionId: 'ssh-1' }
      )
    ).rejects.toThrow('azure_devops_repo_unverifiable')
    expect(getLocalProjectWorktreeGitOptions).not.toHaveBeenCalled()
  })

  it('routes team endpoints by team id when the identity carries one', async () => {
    getAzureDevOpsRepoRef.mockResolvedValue(REPO)
    loadAzureDevOpsBacklogPage.mockResolvedValue({ items: [] })
    const level = { id: 'Microsoft.RequirementCategory' }
    await handlers.get('azureDevOpsBoards:loadBacklog')!(
      {},
      {
        repoPath: '/repo',
        teamName: 'Mobile',
        teamId: 'team-guid',
        level,
        columnFields: ['System.Parent']
      }
    )
    expect(loadAzureDevOpsBacklogPage).toHaveBeenCalledWith(REPO, 'team-guid', level, [
      'System.Parent'
    ])
    await handlers.get('azureDevOpsBoards:getConfiguration')!(
      {},
      { repoPath: '/repo', teamName: 'Mobile' }
    )
    expect(getAzureDevOpsBacklogConfiguration).toHaveBeenCalledWith(REPO, 'Mobile')
  })

  it('reads the per-user view settings only when the team id is known', async () => {
    getAzureDevOpsRepoRef.mockResolvedValue(REPO)
    const backlog = { levels: [{ id: 'Microsoft.RequirementCategory' }], bugsBehavior: 'off' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test asserts only the fields it seeds in the configuration bundle.
    getAzureDevOpsBacklogConfiguration.mockResolvedValue(backlog as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test asserts only the showParents field it seeds.
    getAzureDevOpsBacklogViewSettings.mockResolvedValue({ showParents: true } as never)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler registered for this channel returns the configuration bundle.
    const byName = (await handlers.get('azureDevOpsBoards:getConfiguration')!(
      {},
      { repoPath: '/repo', teamName: 'Mobile' }
    )) as { viewSettings: unknown }
    expect(byName.viewSettings).toBeNull()
    expect(getAzureDevOpsBacklogViewSettings).not.toHaveBeenCalled()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler registered for this channel returns the configuration bundle.
    const byId = (await handlers.get('azureDevOpsBoards:getConfiguration')!(
      {},
      { repoPath: '/repo', teamName: 'Mobile', teamId: 'team-guid' }
    )) as { viewSettings: unknown }
    expect(getAzureDevOpsBacklogViewSettings).toHaveBeenCalledWith(
      REPO,
      'team-guid',
      backlog.levels
    )
    expect(byId.viewSettings).toEqual({ showParents: true })
  })

  it('propagates request failures from the team list instead of an empty list', async () => {
    getAzureDevOpsRepoRef.mockResolvedValue(REPO)
    listAzureDevOpsTeams.mockRejectedValue(new Error('Azure DevOps request failed: HTTP 401'))
    await expect(
      handlers.get('azureDevOpsBoards:listTeams')!({}, { repoPath: '/repo' })
    ).rejects.toThrow('HTTP 401')
  })
})
