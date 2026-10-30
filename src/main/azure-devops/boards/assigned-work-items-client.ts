import type { AzureDevOpsAssignedWorkItemsPage } from '../../../shared/azure-devops/boards-types'
import { requestAzureDevOpsJsonAtBase } from '../azure-devops-api-request'
import type { AzureDevOpsRepoRef } from '../repository-ref'
import { resolveAzureDevOpsApiBases } from './api-bases'
import { hydrateAzureDevOpsWorkItems } from './backlog-client'
import { quoteWiqlLiteral } from './wiql-literal'
import { getAzureDevOpsWorkItemTypes, removedStateNamesForTypes } from './work-item-type-metadata'

// Why: one WIQL read plus batched item reads, like the board; the default 5s budget is per call.
const ASSIGNED_WORK_ITEMS_TIMEOUT_MS = 15_000
const CHANGED_DATE_FIELD = 'System.ChangedDate'
/** The hub's own cap; a longer list is a filter's job, not an unbounded fetch. */
const ASSIGNED_WORK_ITEMS_LIMIT = 1000

/** Beyond the base fields: the view shows the date it orders by. */
const ASSIGNED_WORK_ITEM_FIELDS = [CHANGED_DATE_FIELD] as const

export function buildAzureDevOpsAssignedWorkItemsWiql(
  project: string,
  removedStates: readonly string[] = []
): string {
  // Why: the view drops Removed items anyway, so leaving them in spends WIQL's result budget.
  const removedClause =
    removedStates.length === 0
      ? ''
      : `AND [System.State] NOT IN (${removedStates.map(quoteWiqlLiteral).join(', ')}) `
  return (
    `SELECT [System.Id] FROM WorkItems WHERE ` +
    `[System.TeamProject] = ${quoteWiqlLiteral(project)} AND [System.AssignedTo] = @Me ` +
    `${removedClause}ORDER BY [${CHANGED_DATE_FIELD}] DESC`
  )
}

/**
 * The project's work items assigned to the signed-in user. No team and no backlog
 * level: the query is scoped by project alone, so an item in no team's area shows.
 */
export async function loadAzureDevOpsAssignedWorkItems(
  repo: AzureDevOpsRepoRef
): Promise<AzureDevOpsAssignedWorkItemsPage> {
  const workItemTypes = await getAzureDevOpsWorkItemTypes(repo)
  const query = buildAzureDevOpsAssignedWorkItemsWiql(
    repo.project,
    removedStateNamesForTypes(Object.keys(workItemTypes), workItemTypes)
  )
  // Why: the query IS the list, so a failed read rejects rather than reading as "nothing assigned".
  const raw = await requestAzureDevOpsJsonAtBase<{ workItems?: { id?: number }[] }>(
    resolveAzureDevOpsApiBases(repo).project,
    '/_apis/wit/wiql',
    {
      method: 'POST',
      body: { query },
      searchParams: { $top: String(ASSIGNED_WORK_ITEMS_LIMIT) },
      timeoutMs: ASSIGNED_WORK_ITEMS_TIMEOUT_MS
    },
    true
  )
  const ids = (raw?.workItems ?? [])
    .map((w) => w.id)
    .filter((id): id is number => typeof id === 'number')
  // Why: these rows are the list, so a failed batch rejects; `errorPolicy: 'omit'` means a
  // single unreadable item is a shortfall the view counts in a notice instead.
  const items = await hydrateAzureDevOpsWorkItems(repo, ids, [...ASSIGNED_WORK_ITEM_FIELDS], {
    requireResponse: true
  })
  return { items, unhydratedItemCount: ids.length - items.length }
}
