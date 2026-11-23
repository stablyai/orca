import type {
  AzureDevOpsIteration,
  AzureDevOpsTeam,
  AzureDevOpsTeamAreaPaths
} from '../../../shared/azure-devops/boards-types'
import { requestAzureDevOpsJsonAtBase } from '../azure-devops-api-request'
import type { AzureDevOpsRepoRef } from '../repository-ref'
import { resolveAzureDevOpsApiBases } from './api-bases'

type RawTeam = { id?: string; name?: string }
type RawIteration = {
  id?: string
  name?: string
  path?: string
  attributes?: {
    startDate?: string | null
    finishDate?: string | null
    timeFrame?: string | null
  } | null
}

export async function listAzureDevOpsTeams(repo: AzureDevOpsRepoRef): Promise<AzureDevOpsTeam[]> {
  const bases = resolveAzureDevOpsApiBases(repo)
  const projectPath = `/_apis/projects/${encodeURIComponent(repo.project)}`
  // Why: the team list is the first authenticated call the Tasks view makes; a
  // 401/403/timeout collapsing to `[]` would read as "no teams" instead of a failure.
  const [teams, project] = await Promise.all([
    requestAzureDevOpsJsonAtBase<{ value?: RawTeam[] }>(
      bases.collection,
      `${projectPath}/teams`,
      {},
      true
    ),
    requestAzureDevOpsJsonAtBase<{ defaultTeam?: { id?: string } | null }>(
      bases.collection,
      projectPath
    )
  ])
  const defaultTeamId = project?.defaultTeam?.id ?? null
  return (teams?.value ?? [])
    .filter((team): team is { id: string; name: string } => Boolean(team.id && team.name))
    .map((team) => ({ id: team.id, name: team.name, isDefault: team.id === defaultTeamId }))
}

export async function listAzureDevOpsIterations(
  repo: AzureDevOpsRepoRef,
  teamName: string
): Promise<AzureDevOpsIteration[]> {
  const bases = resolveAzureDevOpsApiBases(repo)
  const raw = await requestAzureDevOpsJsonAtBase<{ value?: RawIteration[] }>(
    bases.team(teamName),
    '/_apis/work/teamsettings/iterations'
  )
  return (raw?.value ?? [])
    .filter((it): it is RawIteration & { id: string; name: string; path: string } =>
      Boolean(it.id && it.name && it.path)
    )
    .map((it) => ({
      id: it.id,
      name: it.name,
      path: it.path,
      timeFrame: normalizeTimeFrame(it.attributes?.timeFrame),
      startDate: it.attributes?.startDate ?? null,
      finishDate: it.attributes?.finishDate ?? null
    }))
}

function normalizeTimeFrame(value: unknown): AzureDevOpsIteration['timeFrame'] {
  return value === 'past' || value === 'current' || value === 'future' ? value : null
}

export async function listAzureDevOpsTeamAreaPaths(
  repo: AzureDevOpsRepoRef,
  teamName: string
): Promise<AzureDevOpsTeamAreaPaths> {
  const raw = await requestAzureDevOpsJsonAtBase<{
    field?: { referenceName?: string } | null
    defaultValue?: string
    values?: { value?: string; includeChildren?: boolean }[]
  }>(
    resolveAzureDevOpsApiBases(repo).team(teamName),
    '/_apis/work/teamsettings/teamfieldvalues',
    {},
    // Why: a failed lookup must not read as "no areas", which disables Board.
    true
  )
  if (!raw?.values) {
    // Why: a body with no `values` array is a 204 or shape drift, not a team without areas.
    throw new Error(`Azure DevOps team field values unavailable for team "${teamName}"`)
  }
  const field = raw.field?.referenceName
  return {
    field: typeof field === 'string' && field.length > 0 ? field : null,
    defaultValue: raw.defaultValue ?? '',
    values: raw.values
      .filter((v): v is { value: string; includeChildren?: boolean } => Boolean(v.value))
      .map((v) => ({ value: v.value, includeChildren: v.includeChildren === true }))
  }
}
