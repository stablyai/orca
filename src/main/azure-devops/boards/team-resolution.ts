import type {
  AzureDevOpsIteration,
  AzureDevOpsTeam
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
