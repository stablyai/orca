import { resolveAzureDevOpsGitApiBaseUrl } from '../azure-devops-api-request'
import type { AzureDevOpsRepoRef } from '../repository-ref'

export type AzureDevOpsApiBases = {
  /** Organisation (hosted) or collection (on-prem) root: `projects/*` lives here. */
  collection: string
  /** Project root: `wit/*` lives here. */
  project: string
  /** Team-scoped root: `work/*` lives here. ADO accepts the team name or id. */
  team: (teamIdOrName: string) => string
  workItemWebUrl: (id: number) => string
}

export function resolveAzureDevOpsApiBases(repo: AzureDevOpsRepoRef): AzureDevOpsApiBases {
  const project = resolveAzureDevOpsGitApiBaseUrl(repo).replace(/\/+$/, '')
  const collection = project.slice(0, project.lastIndexOf('/'))
  return {
    collection,
    project,
    team: (teamIdOrName) => `${project}/${encodeURIComponent(teamIdOrName)}`,
    workItemWebUrl: (id) => `${project}/_workitems/edit/${id}`
  }
}
