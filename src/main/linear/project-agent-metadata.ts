import {
  clampLinearProjectMetadataLimit,
  type LinearProjectLabelsResult,
  type LinearProjectLabelSummary,
  type LinearProjectStatusesResult,
  type LinearProjectStatusSummary,
  type LinearWorkspaceFanoutMeta
} from '../../shared/linear/project-agent-access'
import { getClients, type LinearClientForWorkspace } from './client'
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
  isAssignableProjectLabel,
  readProjectLabelRows,
  readProjectStatusRows
} from './project-metadata-reads'
import { connectedLinearWorkspaces, unknownLinearWorkspace } from './project-workspace-scope'

export type LinearProjectMetadataRequest = {
  query?: string
  limit: number
  workspaceId?: (string & {}) | 'all'
}

type MetadataRow = { id: string; name: string; workspaceId: string; workspaceName: string }

type WorkspaceMetadataPage<TRow> = { rows: TRow[]; hasMore: boolean }

export async function listProjectStatusesForAgent(
  request: LinearProjectMetadataRequest,
  options: { signal?: AbortSignal } = {}
): Promise<LinearProjectStatusesResult> {
  const query = request.query?.trim().toLowerCase()
  const result = await readWorkspaceMetadata<LinearProjectStatusSummary>(
    request,
    async (entry) => ({
      // Why: the workspace status array is unpaginated, so query/limit filtering happens locally.
      rows: (await readProjectStatusRows(entry, options.signal))
        .filter((row) => !row.archived && (!query || row.name.toLowerCase().includes(query)))
        .map(({ archived: _archived, ...status }) => status),
      hasMore: false
    })
  )
  return { statuses: result.rows, meta: result.meta }
}

export async function listProjectLabelsForAgent(
  request: LinearProjectMetadataRequest,
  options: { signal?: AbortSignal } = {}
): Promise<LinearProjectLabelsResult> {
  const query = request.query?.trim()
  const result = await readWorkspaceMetadata<LinearProjectLabelSummary>(request, async (entry) => {
    const page = await readProjectLabelRows(entry, {
      filter: {
        isGroup: { eq: false },
        ...(query ? { name: { containsIgnoreCase: query } } : {})
      },
      signal: options.signal
    })
    return {
      rows: page.rows
        .filter(isAssignableProjectLabel)
        .map(({ isGroup: _isGroup, archived: _archived, retired: _retired, ...label }) => label),
      hasMore: page.hasMore
    }
  })
  return { labels: result.rows, meta: result.meta }
}

async function readWorkspaceMetadata<TRow extends MetadataRow>(
  request: LinearProjectMetadataRequest,
  read: (entry: LinearClientForWorkspace) => Promise<WorkspaceMetadataPage<TRow>>
): Promise<{ rows: TRow[]; meta: LinearWorkspaceFanoutMeta }> {
  const limit = clampLinearProjectMetadataLimit(request.limit)
  const fanout = request.workspaceId === 'all'
  const { entries, failures } = selectMetadataEntries(request.workspaceId)

  const settled = await Promise.allSettled(entries.map((entry) => read(entry)))
  const pages: { entry: LinearClientForWorkspace; page: WorkspaceMetadataPage<TRow> }[] = []
  const workspaceErrors: WorkspaceReadFailure[] = [...failures]
  for (const [index, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      pages.push({ entry: entries[index], page: result.value })
      continue
    }
    // Why: statuses and labels are the only project reads allowed to return partial results.
    if (!fanout) {
      throw result.reason
    }
    workspaceErrors.push(workspaceFailure(entries[index].workspace, toAccessError(result.reason)))
  }
  if (pages.length === 0 && workspaceErrors.length > 0) {
    throw workspaceErrors[0].error
  }

  const rows = pages.flatMap(({ page }) => page.rows).sort(compareMetadataRows)
  const published = rows.slice(0, limit)
  const publishedPerWorkspace = new Map<string, number>()
  for (const row of published) {
    publishedPerWorkspace.set(
      row.workspaceId,
      (publishedPerWorkspace.get(row.workspaceId) ?? 0) + 1
    )
  }

  return {
    rows: published,
    meta: {
      ...(request.query ? { query: request.query } : {}),
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      limit,
      returned: published.length,
      partial: workspaceErrors.length > 0,
      workspaceResults: pages.map(({ entry, page }) => {
        const returned = publishedPerWorkspace.get(entry.workspace.id) ?? 0
        return {
          workspace: { id: entry.workspace.id, name: entry.workspace.organizationName },
          returned,
          // Why: rows dropped by the global cap are still "more" for that workspace.
          hasMore: page.hasMore || returned < page.rows.length
        }
      }),
      workspaceErrors: workspaceErrors.map(({ workspace, code, message }) => ({
        workspace,
        code,
        message
      }))
    }
  }
}

function selectMetadataEntries(workspaceId: (string & {}) | 'all' | undefined): {
  entries: LinearClientForWorkspace[]
  failures: WorkspaceReadFailure[]
} {
  if (workspaceId === 'all') {
    const fanout = getFanoutClientEntries()
    if (fanout.entries.length === 0 && fanout.failures.length === 0) {
      throw notConnected()
    }
    return fanout
  }
  const workspaces = connectedLinearWorkspaces()
  if (workspaceId && workspaces.length > 0 && !workspaces.some(({ id }) => id === workspaceId)) {
    throw unknownLinearWorkspace(workspaceId)
  }
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    throw workspaceId ? unknownLinearWorkspace(workspaceId) : notConnected()
  }
  return { entries, failures: [] }
}

function compareMetadataRows(left: MetadataRow, right: MetadataRow): number {
  return (
    left.workspaceName.localeCompare(right.workspaceName) ||
    left.name.localeCompare(right.name) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  )
}

function toAccessError(error: unknown): LinearAgentAccessError {
  return error instanceof LinearAgentAccessError
    ? error
    : linearError(classifyLinearError(error), linearMessage(error))
}

function notConnected(): LinearAgentAccessError {
  return linearError('linear_not_connected', 'Linear is not connected.', {
    nextSteps: ['Connect Linear from Orca settings, then retry the project metadata read.']
  })
}
