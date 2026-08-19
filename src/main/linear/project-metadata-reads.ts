import {
  LINEAR_PROJECT_LABEL_SCAN_CAP,
  type LinearProjectLabelSummary,
  type LinearProjectStatusSummary
} from '../../shared/linear/project-agent-access'
import type { LinearClientForWorkspace } from './client'
import { runLinearProjectRead, type LinearProjectRawVariables } from './project-agent-request'
import { mapLinearProjectLabelRef, toLinearProjectStatusType } from './project-reference-mapping'

export type LinearProjectStatusRow = LinearProjectStatusSummary & { archived: boolean }

export type LinearProjectLabelRow = LinearProjectLabelSummary & {
  isGroup: boolean
  archived: boolean
  retired: boolean
}

const LABEL_PAGE_SIZE = 50

// Why: Organization.projectStatuses is an unpaginated array — no connection arguments exist.
const PROJECT_STATUSES_QUERY = `
  query OrcaLinearProjectStatuses {
    organization {
      projectStatuses {
        id
        name
        type
        color
        archivedAt
      }
    }
  }
`

const PROJECT_LABELS_QUERY = `
  query OrcaLinearProjectLabels($filter: ProjectLabelFilter, $first: Int!, $after: String) {
    organization {
      projectLabels(filter: $filter, first: $first, after: $after, orderBy: createdAt) {
        nodes {
          id
          name
          color
          isGroup
          archivedAt
          retiredAt
          retiredBy {
            id
          }
          parent {
            id
            name
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`

type ProjectStatusNode = {
  id: string
  name?: string | null
  type?: string | null
  color?: string | null
  archivedAt?: string | null
}

type ProjectLabelNode = {
  id: string
  name?: string | null
  color?: string | null
  isGroup?: boolean | null
  archivedAt?: string | null
  retiredAt?: string | null
  retiredBy?: { id: string } | null
  parent?: { id: string; name?: string | null } | null
}

type ProjectStatusesResponse = { organization?: { projectStatuses?: ProjectStatusNode[] | null } }
type ProjectLabelsResponse = {
  organization?: {
    projectLabels?: {
      nodes?: ProjectLabelNode[] | null
      pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null
    } | null
  }
}

export async function readProjectStatusRows(
  entry: LinearClientForWorkspace,
  signal?: AbortSignal
): Promise<LinearProjectStatusRow[]> {
  const nodes = await runLinearProjectRead(entry, signal, async (client) => {
    const result = await client.client.rawRequest<
      ProjectStatusesResponse,
      LinearProjectRawVariables
    >(PROJECT_STATUSES_QUERY, {})
    return result.data?.organization?.projectStatuses ?? []
  })
  return nodes.map((node) => ({
    id: node.id,
    name: node.name ?? '',
    type: toLinearProjectStatusType(node.type),
    color: node.color ?? '',
    workspaceId: entry.workspace.id,
    workspaceName: entry.workspace.organizationName,
    archived: Boolean(node.archivedAt)
  }))
}

/**
 * Pages project labels for one workspace. `scanCap` bounds discovery reads;
 * write resolution passes `Infinity` because it must prove exact uniqueness.
 */
export async function readProjectLabelRows(
  entry: LinearClientForWorkspace,
  options: {
    filter?: Record<string, unknown>
    scanCap?: number
    signal?: AbortSignal
  } = {}
): Promise<{ rows: LinearProjectLabelRow[]; hasMore: boolean }> {
  const scanCap = options.scanCap ?? LINEAR_PROJECT_LABEL_SCAN_CAP
  const rows: LinearProjectLabelRow[] = []
  let scanned = 0
  let after: string | undefined
  let hasMore = false

  while (scanned < scanCap) {
    const first = Math.min(LABEL_PAGE_SIZE, scanCap - scanned)
    const connection = await runLinearProjectRead(entry, options.signal, async (client) => {
      const result = await client.client.rawRequest<
        ProjectLabelsResponse,
        LinearProjectRawVariables
      >(PROJECT_LABELS_QUERY, {
        first,
        ...(options.filter ? { filter: options.filter } : {}),
        ...(after ? { after } : {})
      })
      return result.data?.organization?.projectLabels
    })
    const nodes = connection?.nodes ?? []
    scanned += nodes.length
    rows.push(...nodes.map((node) => mapProjectLabelRow(entry, node)))
    hasMore = connection?.pageInfo?.hasNextPage === true

    const nextCursor = connection?.pageInfo?.endCursor ?? undefined
    if (!hasMore || !nextCursor || nextCursor === after || nodes.length === 0) {
      break
    }
    after = nextCursor
  }

  return { rows, hasMore }
}

export function isAssignableProjectLabel(row: LinearProjectLabelRow): boolean {
  return !row.isGroup && !row.archived && !row.retired
}

function mapProjectLabelRow(
  entry: LinearClientForWorkspace,
  node: ProjectLabelNode
): LinearProjectLabelRow {
  return {
    ...mapLinearProjectLabelRef(node),
    workspaceId: entry.workspace.id,
    workspaceName: entry.workspace.organizationName,
    isGroup: node.isGroup === true,
    archived: Boolean(node.archivedAt),
    retired: Boolean(node.retiredAt) || Boolean(node.retiredBy?.id)
  }
}
