import type {
  AzureBoardsConnection,
  AzureDevOpsWorkItemComment,
  AzureDevOpsWorkItemSearchPage
} from '../../../../shared/azure-devops/azure-boards-agent-types'
import type {
  AzureDevOpsAssignedWorkItemsPage,
  AzureDevOpsTeam,
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemDetail
} from '../../../../shared/azure-devops/boards-types'
import {
  AZURE_DEVOPS_REMOTE_REQUIRED_ERROR,
  AZURE_DEVOPS_REPO_UNVERIFIABLE_ERROR
} from '../../../../shared/azure-devops/boards-repo-resolution'
import { getRepoRoutingConnectionId } from '../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../shared/repository/repo-types'
import { loadAzureDevOpsAssignedWorkItems } from '../../../azure-devops/boards/assigned-work-items-client'
import { getAzureBoardsConnection } from '../../../azure-devops/boards/boards-connection-client'
import { listAzureDevOpsTeams } from '../../../azure-devops/boards/team-resolution'
import { listAzureDevOpsWorkItemComments } from '../../../azure-devops/boards/work-item-comments-client'
import { getAzureDevOpsWorkItemDetail } from '../../../azure-devops/boards/work-item-client'
import { searchAzureDevOpsWorkItems } from '../../../azure-devops/boards/work-item-search-client'
import {
  addAzureDevOpsWorkItemComment,
  setAzureDevOpsWorkItemAssignee,
  setAzureDevOpsWorkItemState
} from '../../../azure-devops/boards/work-item-write-client'
import {
  getAzureDevOpsRepoRef,
  type AzureDevOpsRepoRef
} from '../../../azure-devops/repository-ref'

type LocalGitArgs = [] | [{ wslDistro?: string }]

export type RuntimeAzureBoardsCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  getLocalGitArgs: (repo: Repo) => LocalGitArgs
}

/** The Azure DevOps project behind a registered repo's remote, for agent reads. */
export async function resolveAzureDevOpsRepoSelector(
  deps: RuntimeAzureBoardsCommandsDeps,
  repoSelector: string
): Promise<AzureDevOpsRepoRef> {
  const repo = await deps.resolveRepo(repoSelector)
  const connectionId = getRepoRoutingConnectionId(repo)
  const ref = await getAzureDevOpsRepoRef(
    repo.path,
    connectionId,
    deps.getLocalGitArgs(repo)[0] ?? {}
  )
  if (!ref) {
    // On a remote host a null probe is loss of contact, never a verdict about the remote.
    throw new Error(
      connectionId ? AZURE_DEVOPS_REPO_UNVERIFIABLE_ERROR : AZURE_DEVOPS_REMOTE_REQUIRED_ERROR
    )
  }
  return ref
}

/** Read-only Azure Boards access for agents; every call is scoped to one registered repo's project. */
export class RuntimeAzureBoardsCommands {
  constructor(private readonly deps: RuntimeAzureBoardsCommandsDeps) {}

  private resolveAzureRepo(repoSelector: string): Promise<AzureDevOpsRepoRef> {
    return resolveAzureDevOpsRepoSelector(this.deps, repoSelector)
  }

  async getAzureBoardsConnection(repoSelector: string): Promise<AzureBoardsConnection> {
    return getAzureBoardsConnection(await this.resolveAzureRepo(repoSelector))
  }

  async getAzureBoardsWorkItem(
    repoSelector: string,
    id: number
  ): Promise<AzureDevOpsWorkItemDetail | null> {
    return getAzureDevOpsWorkItemDetail(await this.resolveAzureRepo(repoSelector), id, {})
  }

  async listAzureBoardsWorkItemComments(
    repoSelector: string,
    id: number,
    limit?: number
  ): Promise<AzureDevOpsWorkItemComment[]> {
    return listAzureDevOpsWorkItemComments(await this.resolveAzureRepo(repoSelector), id, limit)
  }

  async searchAzureBoardsWorkItems(
    repoSelector: string,
    wiql: string,
    limit?: number
  ): Promise<AzureDevOpsWorkItemSearchPage> {
    return searchAzureDevOpsWorkItems(await this.resolveAzureRepo(repoSelector), wiql, limit)
  }

  async listAzureBoardsAssignedWorkItems(
    repoSelector: string
  ): Promise<AzureDevOpsAssignedWorkItemsPage> {
    return loadAzureDevOpsAssignedWorkItems(await this.resolveAzureRepo(repoSelector))
  }

  async listAzureBoardsTeams(repoSelector: string): Promise<AzureDevOpsTeam[]> {
    return listAzureDevOpsTeams(await this.resolveAzureRepo(repoSelector))
  }

  async addAzureBoardsWorkItemComment(
    repoSelector: string,
    id: number,
    text: string
  ): Promise<{ commentId: number }> {
    return addAzureDevOpsWorkItemComment(await this.resolveAzureRepo(repoSelector), id, text)
  }

  async setAzureBoardsWorkItemState(
    repoSelector: string,
    id: number,
    state: string,
    expectedRev?: number
  ): Promise<AzureDevOpsWorkItem> {
    return setAzureDevOpsWorkItemState(
      await this.resolveAzureRepo(repoSelector),
      id,
      state,
      expectedRev
    )
  }

  async setAzureBoardsWorkItemAssignee(
    repoSelector: string,
    id: number,
    assignee: string | null,
    expectedRev?: number
  ): Promise<AzureDevOpsWorkItem> {
    return setAzureDevOpsWorkItemAssignee(
      await this.resolveAzureRepo(repoSelector),
      id,
      assignee,
      expectedRev
    )
  }
}
