import type {
  HulyConnection,
  HulyIssue,
  HulyProjectDetail,
  HulyProjectSummary
} from '../../shared/types'
import { runHulyCli } from './huly-cli'
import { withConnection } from './connection-helpers'
import { listIssues } from './issues'

type RawHulyProject = {
  id?: string
  name?: string
  description?: string
  color?: string
  url?: string
  status?: { id?: string; name?: string; color?: string }
  startDate?: string | null
  targetDate?: string | null
  createdAt?: string
  updatedAt?: string
}

function toSummary(raw: RawHulyProject): HulyProjectSummary | null {
  if (!raw.id || !raw.name) {
    return null
  }
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    color: raw.color,
    url: raw.url,
    status: raw.status
      ? {
          id: raw.status.id ?? '',
          name: raw.status.name ?? '',
          color: raw.status.color
        }
      : undefined,
    startDate: raw.startDate,
    targetDate: raw.targetDate,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  }
}

async function run<T>(connection: HulyConnection, secret: string, args: string[]): Promise<T> {
  return runHulyCli<T>(connection, secret, null, args)
}

export async function listProjects(
  query: string | undefined,
  limit: number,
  connectionId: string | null
): Promise<HulyProjectSummary[]> {
  return withConnection(connectionId, [], async (connection, secret) => {
    const args = ['project', 'list', '--limit', String(limit)]
    if (query) {
      args.push('--query', query)
    }
    const raw = await run<RawHulyProject[]>(connection, secret, args)
    return raw.map(toSummary).filter((project): project is HulyProjectSummary => project !== null)
  })
}

export async function getProject(
  id: string,
  connectionId: string | null
): Promise<HulyProjectDetail | null> {
  return withConnection(connectionId, null, async (connection, secret) => {
    const raw = await run<RawHulyProject>(connection, secret, ['project', 'get', id])
    return toSummary(raw)
  })
}

export async function createProject(
  input: { name: string; description?: string },
  connectionId: string | null
): Promise<{ ok: true; project: HulyProjectSummary } | { ok: false; error: string }> {
  try {
    const result = await withConnection(connectionId, null, async (connection, secret) => {
      const args = ['project', 'create', '--name', input.name]
      if (input.description) {
        args.push('--description', input.description)
      }
      const raw = await run<RawHulyProject>(connection, secret, args)
      const summary = toSummary(raw)
      if (!summary) {
        throw new Error('Invalid project payload')
      }
      return summary
    })
    if (!result) {
      throw new Error('No Huly connection.')
    }
    return { ok: true, project: result }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Project create failed' }
  }
}

// Why: huly CLI exposes issues by team, not by project. Page through the CLI in
// team-sized windows until either `limit` matches of that project are found or
// the CLI returns no further issues, so the caller never silently loses results.
export async function listProjectIssues(
  projectId: string,
  limit: number,
  connectionId: string | null
): Promise<HulyIssue[]> {
  const PAGE = 50
  const MAX_PAGES = 10
  const collected: HulyIssue[] = []
  let fetched = 0
  for (let page = 0; page < MAX_PAGES && collected.length < limit; page += 1) {
    const issues = await listIssues('all', PAGE, connectionId)
    for (const issue of issues) {
      if (issue.project?.id !== projectId) {
        continue
      }
      collected.push(issue)
      if (collected.length >= limit) {
        break
      }
    }
    fetched += issues.length
    if (issues.length < PAGE) {
      break
    }
  }
  return collected
}
