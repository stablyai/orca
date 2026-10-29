import { resolve } from 'node:path'
import { ipcMain } from 'electron'
import type {
  AzureDevOpsBacklogLevel,
  AzureDevOpsBacklogPage,
  AzureDevOpsTeam,
  AzureDevOpsTeamConfiguration,
  AzureDevOpsWorkItemDetail
} from '../../shared/azure-devops/boards-types'
import {
  AZURE_DEVOPS_REMOTE_REQUIRED_ERROR,
  AZURE_DEVOPS_REPO_UNVERIFIABLE_ERROR,
  azureDevOpsTeamRouteSegment,
  type AzureDevOpsBoardsRepoArgs,
  type AzureDevOpsTeamRoute
} from '../../shared/azure-devops/boards-repo-resolution'
import type { Repo } from '../../shared/repo-types'
import { loadAzureDevOpsBacklogPage } from '../azure-devops/boards/backlog-client'
import { getAzureDevOpsBacklogViewSettings } from '../azure-devops/boards/backlog-view-settings-client'
import { getAzureDevOpsBacklogConfiguration } from '../azure-devops/boards/board-configuration-client'
import {
  listAzureDevOpsIterations,
  listAzureDevOpsTeams
} from '../azure-devops/boards/team-resolution'
import { getAzureDevOpsWorkItemDetail } from '../azure-devops/boards/work-item-client'
import { getAzureDevOpsWorkItemTypes } from '../azure-devops/boards/work-item-type-metadata'
import { isAzureDevOpsReviewCreationAuthenticated } from '../azure-devops/pull-request-creation'
import { getAzureDevOpsRepoRef, type AzureDevOpsRepoRef } from '../azure-devops/repository-ref'
import type { Store } from '../persistence'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'

function findRegisteredRepo(store: Store, args: AzureDevOpsBoardsRepoArgs): Repo | null {
  if (args.repoId) {
    const repo = store.getRepo(args.repoId)
    if (repo && repo.path === args.repoPath) {
      return repo
    }
  }
  const repoPath = resolve(args.repoPath)
  return store.getRepos().find((repo) => resolve(repo.path) === repoPath) ?? null
}

// Why: a WSL project runs `git remote get-url` inside the distro; the renderer never knows that.
function resolveLocalGitOptions(
  store: Store,
  args: AzureDevOpsBoardsRepoArgs
): { wslDistro?: string } {
  if (args.connectionId) {
    return {}
  }
  const repo = findRegisteredRepo(store, args)
  return repo ? getLocalProjectWorktreeGitOptions(store, repo) : {}
}

async function resolveRepo(
  store: Store,
  args: AzureDevOpsBoardsRepoArgs
): Promise<{ repo: AzureDevOpsRepoRef; localGitOptions: { wslDistro?: string } }> {
  const connectionId = args.connectionId ?? null
  const localGitOptions = resolveLocalGitOptions(store, args)
  const repo = await getAzureDevOpsRepoRef(args.repoPath, connectionId, localGitOptions)
  if (!repo) {
    // Why: on a remote host a null probe is loss of contact, never a verdict about the remote.
    throw new Error(
      connectionId ? AZURE_DEVOPS_REPO_UNVERIFIABLE_ERROR : AZURE_DEVOPS_REMOTE_REQUIRED_ERROR
    )
  }
  return { repo, localGitOptions }
}

export function registerAzureDevOpsBoardsHandlers(store: Store): void {
  ipcMain.handle(
    'azureDevOpsBoards:isAuthenticated',
    async (_event, args: AzureDevOpsBoardsRepoArgs): Promise<boolean> => {
      const { localGitOptions } = await resolveRepo(store, args)
      return isAzureDevOpsReviewCreationAuthenticated(args.repoPath, args.connectionId ?? null, {
        localGitExecOptions: localGitOptions
      })
    }
  )

  ipcMain.handle(
    'azureDevOpsBoards:listTeams',
    async (_event, args: AzureDevOpsBoardsRepoArgs): Promise<AzureDevOpsTeam[]> => {
      const { repo } = await resolveRepo(store, args)
      return listAzureDevOpsTeams(repo)
    }
  )

  ipcMain.handle(
    'azureDevOpsBoards:getConfiguration',
    async (
      _event,
      args: AzureDevOpsBoardsRepoArgs & AzureDevOpsTeamRoute
    ): Promise<AzureDevOpsTeamConfiguration> => {
      const { repo } = await resolveRepo(store, args)
      const team = azureDevOpsTeamRouteSegment(args)
      const [backlog, iterations, workItemTypes] = await Promise.all([
        getAzureDevOpsBacklogConfiguration(repo, team),
        listAzureDevOpsIterations(repo, team),
        getAzureDevOpsWorkItemTypes(repo)
      ])
      // Why: the settings endpoint is keyed by team id only; a name-routed team has no per-user view.
      const viewSettings =
        args.teamId && backlog
          ? await getAzureDevOpsBacklogViewSettings(repo, args.teamId, backlog.levels)
          : null
      return {
        backlog,
        iterations,
        workItemTypes,
        repo: { organization: repo.organization ?? null, project: repo.project },
        viewSettings
      }
    }
  )

  ipcMain.handle(
    'azureDevOpsBoards:loadBacklog',
    async (
      _event,
      args: AzureDevOpsBoardsRepoArgs &
        AzureDevOpsTeamRoute & { level: AzureDevOpsBacklogLevel; columnFields?: string[] }
    ): Promise<AzureDevOpsBacklogPage> => {
      const { repo } = await resolveRepo(store, args)
      return loadAzureDevOpsBacklogPage(
        repo,
        azureDevOpsTeamRouteSegment(args),
        args.level,
        args.columnFields ?? []
      )
    }
  )

  ipcMain.handle(
    'azureDevOpsBoards:getWorkItem',
    async (
      _event,
      args: AzureDevOpsBoardsRepoArgs & { id: number }
    ): Promise<AzureDevOpsWorkItemDetail | null> => {
      const { repo } = await resolveRepo(store, args)
      return getAzureDevOpsWorkItemDetail(repo, args.id)
    }
  )
}
