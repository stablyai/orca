import type { AzureDevOpsWorkItemSearchPage } from '../../../shared/azure-devops/azure-boards-agent-types'
import { requestAzureDevOpsJsonAtBase } from '../azure-devops-api-request'
import type { AzureDevOpsRepoRef } from '../repository-ref'
import { resolveAzureDevOpsApiBases } from './api-bases'
import { hydrateAzureDevOpsWorkItems } from './backlog-client'

const SEARCH_TIMEOUT_MS = 15_000
export const AZURE_BOARDS_SEARCH_DEFAULT_LIMIT = 50
export const AZURE_BOARDS_SEARCH_MAX_LIMIT = 200

type RawWiqlResult = {
  workItems?: { id?: number }[]
  // Link queries (`FROM WorkItemLinks`) answer with relations instead of a flat list.
  workItemRelations?: { source?: { id?: number } | null; target?: { id?: number } | null }[]
}

export function workItemIdsFromWiqlResult(raw: RawWiqlResult | null): number[] {
  const ids = new Set<number>()
  for (const item of raw?.workItems ?? []) {
    if (typeof item.id === 'number') {
      ids.add(item.id)
    }
  }
  for (const relation of raw?.workItemRelations ?? []) {
    for (const end of [relation.source, relation.target]) {
      if (typeof end?.id === 'number') {
        ids.add(end.id)
      }
    }
  }
  return [...ids]
}

/** Runs a caller's WIQL as written: POST `wit/wiql` is a read, and nothing here edits the query. */
export async function searchAzureDevOpsWorkItems(
  repo: AzureDevOpsRepoRef,
  wiql: string,
  limit: number = AZURE_BOARDS_SEARCH_DEFAULT_LIMIT
): Promise<AzureDevOpsWorkItemSearchPage> {
  const top = Math.min(Math.max(1, Math.floor(limit)), AZURE_BOARDS_SEARCH_MAX_LIMIT)
  const raw = await requestAzureDevOpsJsonAtBase<RawWiqlResult>(
    resolveAzureDevOpsApiBases(repo).project,
    '/_apis/wit/wiql',
    {
      method: 'POST',
      body: { query: wiql },
      searchParams: { $top: String(top) },
      timeoutMs: SEARCH_TIMEOUT_MS
    },
    true
  )
  const ids = workItemIdsFromWiqlResult(raw).slice(0, top)
  const items = await hydrateAzureDevOpsWorkItems(repo, ids, ['System.ChangedDate'], {
    requireResponse: true
  })
  return {
    items,
    unhydratedItemCount: ids.length - items.length,
    ...(ids.length >= top ? { truncatedAtLimit: top } : {})
  }
}
