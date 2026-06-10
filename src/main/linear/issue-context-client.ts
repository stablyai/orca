import type {
  LinearSearchIssueSummary,
  LinearSearchResult,
  LinearWorkspaceCandidate
} from '../../shared/linear-agent-access'
import { clampLinearSearchLimit } from '../../shared/linear-agent-access'
import type { LinearWorkspace } from '../../shared/types'
import {
  acquire,
  clearToken,
  getClients,
  getStatus,
  isAuthError,
  release,
  type LinearClientForWorkspace
} from './client'
import {
  ISSUE_QUERY,
  SEARCH_QUERY,
  mapIssue,
  pickSearchIssue,
  type RawIssueResponse
} from './issue-context-raw'
import { classifyLinearError, linearError, linearMessage } from './issue-context-errors'

export type ResolvedIssue = {
  issue: ReturnType<typeof mapIssue>
  workspace: LinearWorkspace
}

export async function searchLinearIssuesForAgents(args: {
  query: string
  limit?: number
  workspaceId?: string | 'all'
}): Promise<LinearSearchResult> {
  const limit = clampLinearSearchLimit(args.limit)
  const workspaceId = args.workspaceId
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    throw linearError('linear_not_connected', 'Linear is not connected.', {
      nextSteps: ['Connect Linear from Orca settings, then retry the search.']
    })
  }

  const perWorkspace = await Promise.all(
    entries.map(async (entry) => readSearchWorkspace(entry, args.query, limit + 1, workspaceId))
  )
  const merged = perWorkspace
    .flat()
    .sort((left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''))
  const limited = merged.slice(0, limit)
  return {
    issues: limited,
    meta: {
      query: args.query,
      workspaceId,
      limit,
      returned: limited.length,
      limitReached: merged.length > limit
    }
  }
}

export async function resolveIssue(
  identifier: string,
  selectors: { workspaceId?: string | null; organizationUrlKey?: string | null }
): Promise<ResolvedIssue> {
  const workspace = resolveWorkspaceSelector(selectors)
  const entries = getClients(workspace?.id ?? 'all')
  if (entries.length === 0) {
    throw linearError('linear_not_connected', 'Linear is not connected.', {
      nextSteps: ['Connect Linear from Orca settings, then retry the issue read.']
    })
  }

  const results = (
    await Promise.all(entries.map((entry) => readIssueWorkspace(entry, identifier)))
  ).filter((issue): issue is ResolvedIssue => issue !== null)

  if (results.length === 0) {
    throw linearError('linear_issue_not_found', `Linear issue ${identifier} was not found.`)
  }
  if (results.length > 1) {
    throw ambiguousWorkspace(
      results.map((result) => result.workspace),
      identifier
    )
  }
  return results[0]
}

export function getConnectedWorkspaces(): LinearWorkspace[] {
  return getStatus().workspaces ?? []
}

export function getRequiredEntry(workspaceId: string): LinearClientForWorkspace {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw linearError('linear_not_connected', 'Linear is not connected.')
  }
  return entry
}

export async function withLinearRead<T>(
  entry: LinearClientForWorkspace,
  read: () => Promise<T>,
  selection?: string | 'all'
): Promise<T> {
  void selection
  await acquire()
  try {
    return await read()
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw linearError('linear_auth_expired', 'Linear authentication expired.', {
        nextSteps: ['Reconnect Linear from Orca settings.']
      })
    }
    throw linearError(classifyLinearError(error), linearMessage(error))
  } finally {
    release()
  }
}

function resolveWorkspaceSelector(selectors: {
  workspaceId?: string | null
  organizationUrlKey?: string | null
}): LinearWorkspace | null {
  const workspaces = getConnectedWorkspaces()
  if (workspaces.length === 0) {
    return null
  }
  const byId = selectors.workspaceId
    ? workspaces.find((workspace) => workspace.id === selectors.workspaceId)
    : null
  const byOrg = selectors.organizationUrlKey
    ? workspaces.find((workspace) => workspace.organizationUrlKey === selectors.organizationUrlKey)
    : null

  if (selectors.workspaceId && !byId) {
    throw linearError(
      'linear_invalid_workspace',
      `Unknown Linear workspace ${selectors.workspaceId}.`,
      {
        nextSteps: [
          'Run `orca linear search <query> --workspace all --json` to inspect workspace ids.'
        ]
      }
    )
  }
  if (selectors.organizationUrlKey && !byOrg) {
    throw linearError(
      'linear_invalid_workspace',
      `Linear organization ${selectors.organizationUrlKey} is not connected.`,
      {
        nextSteps: ['Connect that Linear workspace or pass --workspace for a connected workspace.']
      }
    )
  }
  if (byId && byOrg && byId.id !== byOrg.id) {
    throw linearError('linear_invalid_workspace', 'The issue URL and --workspace do not match.', {
      nextSteps: [
        `Retry with --workspace ${byOrg.id} or use an issue URL from ${byId.organizationName}.`
      ]
    })
  }
  return byId ?? byOrg ?? null
}

async function readIssueWorkspace(
  entry: LinearClientForWorkspace,
  identifier: string
): Promise<ResolvedIssue | null> {
  const response = await withLinearRead(entry, async () => {
    const raw = await entry.client.client.rawRequest<RawIssueResponse, Record<string, unknown>>(
      ISSUE_QUERY,
      { id: identifier }
    )
    return raw.data?.issue ?? null
  })
  return response ? { issue: mapIssue(response), workspace: entry.workspace } : null
}

async function readSearchWorkspace(
  entry: LinearClientForWorkspace,
  query: string,
  limit: number,
  workspaceId?: string | 'all'
): Promise<LinearSearchIssueSummary[]> {
  const response = await withLinearRead(
    entry,
    async () => {
      const raw = await entry.client.client.rawRequest<RawIssueResponse, Record<string, unknown>>(
        SEARCH_QUERY,
        { term: query, first: limit }
      )
      return raw.data?.searchIssues?.nodes ?? []
    },
    workspaceId
  )
  return response.map((issue) => ({
    ...pickSearchIssue(mapIssue(issue)),
    workspace: {
      id: entry.workspace.id,
      name: entry.workspace.organizationName
    }
  }))
}

function ambiguousWorkspace(
  workspaces: LinearWorkspace[],
  identifier: string
): ReturnType<typeof linearError> {
  const candidates: LinearWorkspaceCandidate[] = workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.organizationName
  }))
  return linearError(
    'linear_workspace_ambiguous',
    `Linear issue ${identifier} exists in more than one workspace.`,
    {
      candidates,
      nextSteps: candidates.map(
        (candidate) => `Retry with --workspace ${candidate.id} for ${candidate.name}.`
      )
    }
  )
}
