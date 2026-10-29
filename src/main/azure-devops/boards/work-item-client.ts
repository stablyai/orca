import type { AzureDevOpsWorkItemDetail } from '../../../shared/azure-devops/boards-types'
import { requestAzureDevOpsJsonAtBase } from '../azure-devops-api-request'
import type { AzureDevOpsRepoRef } from '../repository-ref'
import { resolveAzureDevOpsApiBases } from './api-bases'
import {
  mapAzureDevOpsWorkItem,
  type RawAzureDevOpsWorkItem,
  type RawRelation
} from './work-item-mappers'

function relatedWorkItemId(relation: RawRelation): number | null {
  const match = /\/workItems\/(\d+)$/i.exec(relation.url ?? '')
  return match ? Number(match[1]) : null
}

type PullRequestArtifact = { projectId: string; repoId: string; id: number }

/** `vstfs:///Git/PullRequestId/{projectId}%2F{repoId}%2F{prId}` → all three segments. */
function pullRequestArtifact(relation: RawRelation): PullRequestArtifact | null {
  if (relation.rel !== 'ArtifactLink' || !relation.url?.startsWith('vstfs:///Git/PullRequestId/')) {
    return null
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(relation.url.slice('vstfs:///Git/PullRequestId/'.length))
  } catch {
    // Why: one corrupt artifact link must not sink the whole work item.
    return null
  }
  const [projectId, repoId, last] = decoded.split('/')
  const id = Number(last)
  return projectId && repoId && last && Number.isInteger(id) ? { projectId, repoId, id } : null
}

// Why: PRs can live in another repository of the project; the web UI accepts GUIDs for both.
function pullRequestWebUrl(repo: AzureDevOpsRepoRef, artifact: PullRequestArtifact): string {
  const projectRoot = repo.webBaseUrl.slice(0, repo.webBaseUrl.lastIndexOf('/_git/'))
  const collection = projectRoot.slice(0, projectRoot.lastIndexOf('/'))
  return `${collection}/${artifact.projectId}/_git/${artifact.repoId}/pullrequest/${artifact.id}`
}

function htmlField(fields: Record<string, unknown>, name: string): string | null {
  const value = fields[name]
  return typeof value === 'string' && value.trim() ? value : null
}

export async function getAzureDevOpsWorkItemDetail(
  repo: AzureDevOpsRepoRef,
  id: number
): Promise<AzureDevOpsWorkItemDetail | null> {
  const bases = resolveAzureDevOpsApiBases(repo)
  const raw = await requestAzureDevOpsJsonAtBase<RawAzureDevOpsWorkItem>(
    bases.project,
    `/_apis/wit/workitems/${id}`,
    { searchParams: { $expand: 'all' } }
  )
  if (!raw) {
    return null
  }
  const base = mapAzureDevOpsWorkItem(raw, bases.workItemWebUrl)
  if (!base) {
    return null
  }
  const fields = raw.fields ?? {}
  const relations = raw.relations ?? []
  const createdDate = fields['System.CreatedDate']
  const changedDate = fields['System.ChangedDate']
  return {
    ...base,
    descriptionHtml: htmlField(fields, 'System.Description'),
    acceptanceCriteriaHtml: htmlField(fields, 'Microsoft.VSTS.Common.AcceptanceCriteria'),
    childIds: relations
      .filter((r) => r.rel === 'System.LinkTypes.Hierarchy-Forward')
      .map(relatedWorkItemId)
      .filter((childId): childId is number => childId !== null),
    pullRequestLinks: relations
      .map(pullRequestArtifact)
      .filter((artifact): artifact is PullRequestArtifact => artifact !== null)
      .map((artifact) => ({ id: artifact.id, url: pullRequestWebUrl(repo, artifact) })),
    createdDate: typeof createdDate === 'string' ? createdDate : null,
    changedDate: typeof changedDate === 'string' ? changedDate : null
  }
}
