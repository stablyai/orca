import type { LinearSearchIssueSummary, LinearSearchResult } from '../../shared/linear-agent-access'
import { clampLinearSearchLimit } from '../../shared/linear-agent-access'
import type { LinearWorkspace } from '../../shared/types'
import {
  acquire,
  clearToken,
  getClients,
  getPublicFileUrlClient,
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
import {
  LinearAgentAccessError,
  classifyLinearError,
  linearError,
  linearMessage
} from './issue-context-errors'
import { getFanoutClientEntries, type WorkspaceReadFailure } from './issue-context-fanout'
import {
  readLinearIssueWorkspaceFanout,
  readLinearSearchWorkspaceFanout
} from './issue-context-fanout-reads'
import {
  ambiguousWorkspace,
  resolveWorkspaceSelector,
  unknownWorkspace
} from './issue-context-workspaces'

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
  const workspaceId = resolveSearchWorkspaceId(args.workspaceId)
  const { entries, failures: entryFailures } =
    workspaceId === 'all' ? getFanoutClientEntries() : getExplicitClientEntries(workspaceId)
  if (entries.length === 0) {
    throwIfExplicitWorkspaceHasConnectedAlternatives(workspaceId)
    if (entryFailures[0]) {
      throw entryFailures[0].error
    }
    throw linearError('linear_not_connected', 'Linear is not connected.', {
      nextSteps: ['Connect Linear from Orca settings, then retry the search.']
    })
  }

  const perWorkspace = await readLinearSearchWorkspaceFanout(
    entries,
    workspaceId,
    (entry) => readSearchWorkspace(entry, args.query, limit + 1, workspaceId),
    entryFailures
  )
  const merged = perWorkspace.results
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
      limitReached: perWorkspace.truncated || merged.length > limit,
      partial: perWorkspace.truncated || perWorkspace.failures.length > 0,
      workspaceErrors: perWorkspace.failures.map(({ workspace, code, message }) => ({
        workspace,
        code,
        message
      }))
    }
  }
}

export async function resolveIssue(
  identifier: string,
  selectors: { workspaceId?: string | null; organizationUrlKey?: string | null }
): Promise<ResolvedIssue> {
  const workspace = resolveWorkspaceSelector(selectors, getConnectedWorkspaces())
  const selection = workspace?.id ?? selectors.workspaceId ?? 'all'
  const { entries, failures: entryFailures } =
    selection === 'all' ? getFanoutClientEntries() : getExplicitClientEntries(selection)
  if (entries.length === 0) {
    throwIfExplicitWorkspaceHasConnectedAlternatives(selection)
    if (entryFailures[0]) {
      throw entryFailures[0].error
    }
    throw linearError('linear_not_connected', 'Linear is not connected.', {
      nextSteps: ['Connect Linear from Orca settings, then retry the issue read.']
    })
  }

  const issueFanout = await readLinearIssueWorkspaceFanout(
    entries,
    selection,
    (entry) => readIssueWorkspace(entry, identifier),
    entryFailures
  )
  const results = issueFanout.results

  if (results.length === 0) {
    if (issueFanout.truncated) {
      throw linearError(
        'linear_partial',
        'Linear issue lookup exceeded its aggregate result budget.'
      )
    }
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

export const getConnectedWorkspaces = (): LinearWorkspace[] => getStatus().workspaces ?? []

export function getRequiredEntry(workspaceId: string): LinearClientForWorkspace {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw linearError('linear_not_connected', 'Linear is not connected.')
  }
  return entry
}

function getExplicitClientEntries(workspaceId?: string): {
  entries: LinearClientForWorkspace[]
  failures: WorkspaceReadFailure[]
} {
  try {
    return { entries: getClients(workspaceId), failures: [] }
  } catch (error) {
    if (error instanceof LinearAgentAccessError) {
      throw error
    }
    throw linearError(classifyLinearError(error), linearMessage(error))
  }
}

function resolveSearchWorkspaceId(workspaceId?: string | 'all'): string | 'all' | undefined {
  if (!workspaceId || workspaceId === 'all') {
    return workspaceId
  }
  return resolveWorkspaceSelector({ workspaceId }, getConnectedWorkspaces())?.id ?? workspaceId
}

function throwIfExplicitWorkspaceHasConnectedAlternatives(workspaceId?: string | 'all'): void {
  if (!workspaceId || workspaceId === 'all') {
    return
  }
  try {
    if (getClients('all').length > 0) {
      throw unknownWorkspace(workspaceId)
    }
  } catch (error) {
    if (error instanceof LinearAgentAccessError && error.code === 'linear_invalid_workspace') {
      throw error
    }
  }
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

async function readIssueWorkspace(
  entry: LinearClientForWorkspace,
  identifier: string
): Promise<ResolvedIssue | null> {
  const response = await withLinearRead(entry, async () => {
    const client = getPublicFileUrlClient(entry)
    const raw = await client.client.rawRequest<RawIssueResponse, Record<string, unknown>>(
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
      return (raw.data?.searchIssues?.nodes ?? []).slice(0, limit)
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
