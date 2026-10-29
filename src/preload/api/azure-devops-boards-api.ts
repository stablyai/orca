import type {
  AzureDevOpsBacklogLevel,
  AzureDevOpsBacklogPage,
  AzureDevOpsTeam,
  AzureDevOpsTeamConfiguration,
  AzureDevOpsWorkItemDetail
} from '../../shared/azure-devops/boards-types'
import type {
  AzureDevOpsBoardsRepoArgs,
  AzureDevOpsTeamRoute
} from '../../shared/azure-devops/boards-repo-resolution'

export type AzureDevOpsBoardsApi = {
  isAuthenticated: (args: AzureDevOpsBoardsRepoArgs) => Promise<boolean>
  listTeams: (args: AzureDevOpsBoardsRepoArgs) => Promise<AzureDevOpsTeam[]>
  getConfiguration: (
    args: AzureDevOpsBoardsRepoArgs & AzureDevOpsTeamRoute
  ) => Promise<AzureDevOpsTeamConfiguration>
  loadBacklog: (
    args: AzureDevOpsBoardsRepoArgs &
      AzureDevOpsTeamRoute & {
        level: AzureDevOpsBacklogLevel
        /** Extra reference names to hydrate (the user's own column options). Optional for older hosts. */
        columnFields?: string[]
      }
  ) => Promise<AzureDevOpsBacklogPage>
  getWorkItem: (
    args: AzureDevOpsBoardsRepoArgs & { id: number }
  ) => Promise<AzureDevOpsWorkItemDetail | null>
}
