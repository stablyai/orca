import type {
  AzureDevOpsBacklogLevel,
  AzureDevOpsWorkItemTypeMetadata,
  AzureDevOpsBoardPage,
  AzureDevOpsBoardSummary,
  AzureDevOpsTeamAreaPaths
} from '../../../shared/azure-devops/boards-types'
import { requestAzureDevOpsJsonAtBase } from '../azure-devops-api-request'
import type { AzureDevOpsRepoRef } from '../repository-ref'
import { resolveAzureDevOpsApiBases } from './api-bases'
import { hydrateAzureDevOpsWorkItems } from './backlog-client'
import {
  getAzureDevOpsBoardConfiguration,
  listAzureDevOpsBoards
} from './board-configuration-client'
import { listAzureDevOpsTeamAreaPaths } from './team-resolution'
import { getAzureDevOpsWorkItemTypes } from './work-item-type-metadata'

const BOARD_TIMEOUT_MS = 15_000
const STACK_RANK_FIELD = 'Microsoft.VSTS.Common.StackRank'
const AREA_PATH_FIELD = 'System.AreaPath'

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// Why: stock processes name each board after its backlog level; a miss leaves Board disabled rather than guessing.
export function resolveAzureDevOpsBoardForLevel(
  boards: AzureDevOpsBoardSummary[],
  level: AzureDevOpsBacklogLevel
): AzureDevOpsBoardSummary | null {
  const wanted = level.name.trim().toLowerCase()
  return boards.find((b) => b.name.trim().toLowerCase() === wanted) ?? null
}

/** State names the board discards anyway, so the query never carries them. */
export function removedStateNames(
  level: AzureDevOpsBacklogLevel,
  workItemTypes: Record<string, AzureDevOpsWorkItemTypeMetadata>
): string[] {
  const names = new Set<string>()
  for (const typeName of level.workItemTypes) {
    for (const state of workItemTypes[typeName]?.states ?? []) {
      if (state.category === 'Removed') {
        names.add(state.name)
      }
    }
  }
  return [...names]
}

export function buildAzureDevOpsBoardWiql(
  project: string,
  level: AzureDevOpsBacklogLevel,
  areas: AzureDevOpsTeamAreaPaths,
  removedStates: readonly string[] = []
): string {
  const types = level.workItemTypes.map(quote).join(', ')
  // A team migrated from TFS scopes its board by a custom field, not the area path.
  const teamField = areas.field ?? AREA_PATH_FIELD
  const areaClauses = areas.values.map(
    (a) => `[${teamField}] ${a.includeChildren ? 'UNDER' : '='} ${quote(a.value)}`
  )
  // Why: the layout drops Removed cards after hydration, so leaving them in the query spends
  // WIQL's result budget and a batch fetch on rows the board will never show.
  const removedClause =
    removedStates.length === 0
      ? ''
      : `AND [System.State] NOT IN (${removedStates.map(quote).join(', ')}) `
  return (
    `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = ${quote(project)} AND ` +
    `[System.WorkItemType] IN (${types}) AND (${areaClauses.join(' OR ')}) ${removedClause}` +
    `ORDER BY [${STACK_RANK_FIELD}]`
  )
}

export async function loadAzureDevOpsBoardPage(
  repo: AzureDevOpsRepoRef,
  teamName: string,
  level: AzureDevOpsBacklogLevel
): Promise<AzureDevOpsBoardPage | null> {
  const board = resolveAzureDevOpsBoardForLevel(await listAzureDevOpsBoards(repo, teamName), level)
  if (!board) {
    return null
  }
  const [configuration, areas, workItemTypes] = await Promise.all([
    getAzureDevOpsBoardConfiguration(repo, teamName, board.id),
    listAzureDevOpsTeamAreaPaths(repo, teamName),
    getAzureDevOpsWorkItemTypes(repo)
  ])
  if (!configuration) {
    // Why: the board exists by name, so a missing configuration is a failed request, not "no board".
    throw new Error(`Azure DevOps board configuration unavailable for "${board.name}"`)
  }
  if (areas.values.length === 0) {
    // A team with no team field value has no board content; a failed lookup threw above.
    return null
  }
  const query = buildAzureDevOpsBoardWiql(
    repo.project,
    level,
    areas,
    removedStateNames(level, workItemTypes)
  )
  const raw = await requestAzureDevOpsJsonAtBase<{ workItems?: { id?: number }[] }>(
    resolveAzureDevOpsApiBases(repo).project,
    '/_apis/wit/wiql',
    { method: 'POST', body: { query }, timeoutMs: BOARD_TIMEOUT_MS },
    true
  )
  const ids = (raw?.workItems ?? [])
    .map((w) => w.id)
    .filter((id): id is number => typeof id === 'number')
  const cardFields = Object.values(configuration.cardFields).flatMap((c) =>
    c.fields.map((f) => f.referenceName)
  )
  // Why: the card fetch is the board, so a failed request rejects; `errorPolicy: 'omit'`
  // means a single deleted or now-invisible item is a shortfall the view reports instead.
  const items = await hydrateAzureDevOpsWorkItems(
    repo,
    ids,
    [
      configuration.columnField,
      configuration.rowField,
      configuration.doneField,
      STACK_RANK_FIELD,
      ...cardFields
    ],
    { requireResponse: true }
  )
  const onBoard = new Set(items.map((i) => i.id))
  const parentIds = Array.from(
    new Set(items.map((i) => i.parentId).filter((p): p is number => p !== null && !onBoard.has(p)))
  )
  const parents = await hydrateAzureDevOpsWorkItems(repo, parentIds, [])
  return {
    level,
    configuration,
    items,
    parents,
    unhydratedItemCount: ids.length - items.length,
    unhydratedParentCount: parentIds.length - parents.length
  }
}
