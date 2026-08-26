import type { LinearCycleSummary } from '../../shared/linear/cycle-types'
import type { LinearClientForWorkspace } from './client'
import { withLinearRead } from './issue-context-client'
import { linearError } from './issue-context-errors'

const CYCLE_PAGE_SIZE = 50
const CYCLE_MAX_PAGES = 200

type RawCycle = {
  id: string
  number: number
  name?: string | null
  description?: string | null
  startsAt: string
  endsAt: string
  isActive: boolean
  isFuture: boolean
  isPast: boolean
}

type CyclePage = {
  nodes?: RawCycle[]
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
}

type TeamCyclesResponse = { team?: { cycles?: CyclePage | null } | null }

const TEAM_CYCLES_QUERY = `
  query OrcaLinearTeamCycles($teamId: String!, $first: Int!, $after: String, $filter: CycleFilter) {
    team(id: $teamId) {
      cycles(first: $first, after: $after, filter: $filter) {
        nodes { id number name description startsAt endsAt isActive isFuture isPast }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`

export async function listTeamCyclesForAgent(
  entry: LinearClientForWorkspace,
  teamId: string,
  currentOnly: boolean
): Promise<LinearCycleSummary[]> {
  const cycles: LinearCycleSummary[] = []
  let after: string | undefined
  let complete = false
  for (let page = 0; page < CYCLE_MAX_PAGES; page += 1) {
    const connection = await withLinearRead(entry, async () => {
      const response = await entry.client.client.rawRequest<
        TeamCyclesResponse,
        Record<string, unknown>
      >(TEAM_CYCLES_QUERY, {
        teamId,
        first: CYCLE_PAGE_SIZE,
        after,
        ...(currentOnly ? { filter: { isActive: { eq: true } } } : {})
      })
      return response.data?.team?.cycles
    })
    cycles.push(...(connection?.nodes ?? []).map(mapCycle))
    if (connection?.pageInfo?.hasNextPage !== true || !connection.pageInfo.endCursor) {
      complete = true
      break
    }
    after = connection.pageInfo.endCursor
  }
  if (!complete) {
    throw linearError('linear_partial', 'Linear cycle discovery exceeded its safe page limit.')
  }
  return cycles.sort((left, right) => left.number - right.number || left.id.localeCompare(right.id))
}

export function matchTeamCycles(cycles: LinearCycleSummary[], input: string): LinearCycleSummary[] {
  const normalized = input.toLowerCase()
  if (normalized === 'current') {
    return cycles.filter((cycle) => cycle.isActive)
  }
  return cycles.filter(
    (cycle) => cycle.id.toLowerCase() === normalized || cycle.name?.toLowerCase() === normalized
  )
}

function mapCycle(cycle: RawCycle): LinearCycleSummary {
  return {
    id: cycle.id,
    number: cycle.number,
    name: cycle.name ?? null,
    description: cycle.description ?? null,
    startsAt: cycle.startsAt,
    endsAt: cycle.endsAt,
    isActive: cycle.isActive,
    isFuture: cycle.isFuture,
    isPast: cycle.isPast
  }
}
