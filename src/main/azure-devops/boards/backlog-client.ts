import type {
  AzureDevOpsBacklogLevel,
  AzureDevOpsBacklogPage,
  AzureDevOpsWorkItem
} from '../../../shared/azure-devops/boards-types'
import { requestAzureDevOpsJsonAtBase } from '../azure-devops-api-request'
import type { AzureDevOpsRepoRef } from '../repository-ref'
import { resolveAzureDevOpsApiBases } from './api-bases'
import {
  BASE_WORK_ITEM_FIELDS,
  mapAzureDevOpsWorkItem,
  type RawAzureDevOpsWorkItem
} from './work-item-mappers'

const HYDRATE_BATCH_SIZE = 200
// Why: a large level plus children is several batched calls; the default 5s budget is per call, but keep headroom for slow tenants.
const BACKLOG_TIMEOUT_MS = 15_000

/**
 * @param options.requireResponse Reject when a batch request itself fails. Items
 *   the host omits from a successful response are still skipped: the caller
 *   compares the returned length with `ids` to report the shortfall.
 */
export async function hydrateAzureDevOpsWorkItems(
  repo: AzureDevOpsRepoRef,
  ids: number[],
  extraFields: string[],
  options: { requireResponse?: boolean } = {}
): Promise<AzureDevOpsWorkItem[]> {
  if (ids.length === 0) {
    return []
  }
  const bases = resolveAzureDevOpsApiBases(repo)
  const fields = Array.from(new Set([...BASE_WORK_ITEM_FIELDS, ...extraFields])).join(',')
  const byId = new Map<number, AzureDevOpsWorkItem>()
  for (let start = 0; start < ids.length; start += HYDRATE_BATCH_SIZE) {
    const batch = ids.slice(start, start + HYDRATE_BATCH_SIZE)
    const raw = await requestAzureDevOpsJsonAtBase<{ value?: RawAzureDevOpsWorkItem[] }>(
      bases.project,
      '/_apis/wit/workitems',
      {
        searchParams: { ids: batch.join(','), fields, errorPolicy: 'omit' },
        timeoutMs: BACKLOG_TIMEOUT_MS
      },
      options.requireResponse === true
    )
    for (const item of raw?.value ?? []) {
      const mapped = mapAzureDevOpsWorkItem(item, bases.workItemWebUrl)
      if (mapped) {
        byId.set(mapped.id, mapped)
      }
    }
  }
  return ids.map((id) => byId.get(id)).filter((i): i is AzureDevOpsWorkItem => i !== undefined)
}

type RawLinkResult = {
  workItemRelations?: {
    rel?: string | null
    source?: { id?: number } | null
    target?: { id?: number }
  }[]
}

export async function listAzureDevOpsChildIds(
  repo: AzureDevOpsRepoRef,
  parentIds: number[]
): Promise<Record<number, number[]>> {
  const result: Record<number, number[]> = {}
  for (const id of parentIds) {
    result[id] = []
  }
  if (parentIds.length === 0) {
    return result
  }
  const bases = resolveAzureDevOpsApiBases(repo)
  const query =
    `SELECT [System.Id] FROM WorkItemLinks ` +
    `WHERE ([Source].[System.Id] IN (${parentIds.join(',')})) ` +
    `AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') ` +
    `AND ([Target].[System.WorkItemType] <> '') MODE (MustContain)`
  const raw = await requestAzureDevOpsJsonAtBase<RawLinkResult>(bases.project, '/_apis/wit/wiql', {
    method: 'POST',
    body: { query },
    timeoutMs: BACKLOG_TIMEOUT_MS
  })
  for (const relation of raw?.workItemRelations ?? []) {
    const parent = relation.source?.id
    const child = relation.target?.id
    if (
      relation.rel === 'System.LinkTypes.Hierarchy-Forward' &&
      typeof parent === 'number' &&
      typeof child === 'number'
    ) {
      ;(result[parent] ??= []).push(child)
    }
  }
  return result
}

function byStackRank(a: AzureDevOpsWorkItem, b: AzureDevOpsWorkItem): number {
  return (a.stackRank ?? Number.MAX_SAFE_INTEGER) - (b.stackRank ?? Number.MAX_SAFE_INTEGER)
}

/**
 * @param columnFields Reference names the renderer will show beyond the process
 *   columns (the user's own column options); every one is hydrated.
 */
export async function loadAzureDevOpsBacklogPage(
  repo: AzureDevOpsRepoRef,
  teamName: string,
  level: AzureDevOpsBacklogLevel,
  columnFields: readonly string[] = []
): Promise<AzureDevOpsBacklogPage> {
  const bases = resolveAzureDevOpsApiBases(repo)
  // Why: the ordered-id call is the backlog; failing it must surface as an error,
  // not as an empty level. Children and parents below stay best-effort.
  const ordered = await requestAzureDevOpsJsonAtBase<{
    workItems?: { target?: { id?: number } }[]
  }>(
    bases.team(teamName),
    `/_apis/work/backlogs/${encodeURIComponent(level.id)}/workItems`,
    { timeoutMs: BACKLOG_TIMEOUT_MS },
    true
  )
  const orderedIds = (ordered?.workItems ?? [])
    .map((w) => w.target?.id)
    .filter((id): id is number => typeof id === 'number')
  const extraFields = [...level.columnFields.map((c) => c.referenceName), ...columnFields]
  const items = await hydrateAzureDevOpsWorkItems(repo, orderedIds, extraFields)

  const childIdsByParent = await listAzureDevOpsChildIds(
    repo,
    items.map((i) => i.id)
  )
  const childIds = Array.from(new Set(Object.values(childIdsByParent).flat()))
  const children = await hydrateAzureDevOpsWorkItems(repo, childIds, extraFields)
  const childById = new Map(children.map((c) => [c.id, c]))
  const childrenByParent: Record<number, number[]> = {}
  for (const [parent, ids] of Object.entries(childIdsByParent)) {
    childrenByParent[Number(parent)] = ids
      .map((id) => childById.get(id))
      .filter((c): c is AzureDevOpsWorkItem => c !== undefined)
      .sort(byStackRank)
      .map((c) => c.id)
  }

  const parentIds = Array.from(
    new Set(items.map((i) => i.parentId).filter((p): p is number => p !== null))
  )
  const parents = await hydrateAzureDevOpsWorkItems(repo, parentIds, [])

  // Why: the Parent column and the dialog also need parents of `parents` (often on a
  // hidden level) and any child parent that is not a level item; one more batch covers both.
  const known = new Set([...items, ...children, ...parents].map((i) => i.id))
  const ancestorIds = Array.from(
    new Set(
      [...children, ...parents]
        .map((i) => i.parentId)
        .filter((p): p is number => p !== null && !known.has(p))
    )
  )
  const ancestors = await hydrateAzureDevOpsWorkItems(repo, ancestorIds, [])

  return { level, items, childrenByParent, children, parents, ancestors }
}
