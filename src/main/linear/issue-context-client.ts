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
import {
  getFanoutClientEntries,
  workspaceFailure,
  type WorkspaceReadFailure
} from './issue-context-fanout'
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

  const perWorkspace = await readSearchWorkspaces(
    entries,
    args.query,
    limit + 1,
    workspaceId,
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
      limitReached: merged.length > limit,
      partial: perWorkspace.failures.length > 0,
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

  const results = await readIssueWorkspaces(entries, identifier, selection, entryFailures)

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

async function readIssueWorkspaces(
  entries: LinearClientForWorkspace[],
  identifier: string,
  selection: string | 'all',
  initialFailures: WorkspaceReadFailure[] = []
): Promise<ResolvedIssue[]> {
  if (selection !== 'all') {
    const selected = await readIssueWorkspace(entries[0], identifier)
    return selected ? [selected] : []
  }

  const settled = await Promise.allSettled(
    entries.map((entry) => readIssueWorkspace(entry, identifier))
  )
  const results: ResolvedIssue[] = []
  const failures: LinearAgentAccessError[] = initialFailures.map((failure) => failure.error)

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      if (result.value) {
        results.push(result.value)
      }
      continue
    }
    if (result.reason instanceof LinearAgentAccessError) {
      failures.push(result.reason)
    }
    console.warn('[linear] agent issue read failed:', result.reason)
  }

  if (results.length === 0 && failures[0]) {
    throw failures[0]
  }
  return results
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

async function readSearchWorkspaces(
  entries: LinearClientForWorkspace[],
  query: string,
  limit: number,
  workspaceId?: string | 'all',
  initialFailures: WorkspaceReadFailure[] = []
): Promise<{ results: LinearSearchIssueSummary[][]; failures: WorkspaceReadFailure[] }> {
  if (workspaceId && workspaceId !== 'all') {
    return {
      results: [await readSearchWorkspace(entries[0], query, limit, workspaceId)],
      failures: []
    }
  }

  const settled = await Promise.allSettled(
    entries.map(async (entry) => readSearchWorkspace(entry, query, limit, workspaceId))
  )
  const attemptedWorkspaceCount = entries.length + initialFailures.length
  const results: LinearSearchIssueSummary[][] = []
  const failures: WorkspaceReadFailure[] = [...initialFailures]
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index]
    if (result.status === 'fulfilled') {
      results.push(result.value)
      continue
    }
    if (result.reason instanceof LinearAgentAccessError) {
      failures.push(workspaceFailure(entries[index].workspace, result.reason))
    }
    console.warn('[linear] agent search failed:', result.reason)
  }

  if (results.length === 0 && failures.length === attemptedWorkspaceCount && failures[0]) {
    throw failures[0].error
  }
  return { results, failures }
}
