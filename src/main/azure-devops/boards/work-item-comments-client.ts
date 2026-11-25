import type { AzureDevOpsWorkItemComment } from '../../../shared/azure-devops/azure-boards-agent-types'
import { requestAzureDevOpsJsonAtBase } from '../azure-devops-api-request'
import type { AzureDevOpsRepoRef } from '../repository-ref'
import { resolveAzureDevOpsApiBases } from './api-bases'

// Server 2020+ and hosted both serve this preview; the comments API never left preview.
const COMMENTS_API_VERSION = '6.0-preview.3'
const COMMENTS_TIMEOUT_MS = 10_000
export const AZURE_BOARDS_COMMENTS_MAX = 200

type RawComment = {
  id?: number
  text?: string | null
  createdDate?: string | null
  modifiedDate?: string | null
  isDeleted?: boolean | null
  createdBy?: { displayName?: string | null; uniqueName?: string | null } | null
}

export function mapAzureDevOpsWorkItemComments(
  raw: { comments?: RawComment[] } | null
): AzureDevOpsWorkItemComment[] {
  return (raw?.comments ?? []).flatMap((comment) =>
    typeof comment.id === 'number' && comment.isDeleted !== true
      ? [
          {
            id: comment.id,
            author: comment.createdBy?.displayName ?? comment.createdBy?.uniqueName ?? null,
            createdDate: comment.createdDate ?? null,
            modifiedDate: comment.modifiedDate ?? null,
            textHtml: comment.text ?? ''
          }
        ]
      : []
  )
}

/** Newest first, as the work item's Discussion shows them. */
export async function listAzureDevOpsWorkItemComments(
  repo: AzureDevOpsRepoRef,
  workItemId: number,
  limit: number = AZURE_BOARDS_COMMENTS_MAX
): Promise<AzureDevOpsWorkItemComment[]> {
  const top = Math.min(Math.max(1, Math.floor(limit)), AZURE_BOARDS_COMMENTS_MAX)
  const raw = await requestAzureDevOpsJsonAtBase<{ comments?: RawComment[] }>(
    resolveAzureDevOpsApiBases(repo).project,
    `/_apis/wit/workItems/${encodeURIComponent(String(workItemId))}/comments`,
    {
      searchParams: { $top: String(top), order: 'desc', 'api-version': COMMENTS_API_VERSION },
      timeoutMs: COMMENTS_TIMEOUT_MS
    },
    true
  )
  return mapAzureDevOpsWorkItemComments(raw)
}
