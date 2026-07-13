import type { GitHubPrStartPoint } from '../../../src/shared/types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import type {
  NewWorkspaceSourceFilter,
  NewWorkspaceSourceRow,
  WorkspaceSourceAvailability
} from './new-workspace-source-types'
import {
  normalizeGitHubSourceResponse,
  normalizeLinearSourceResponse,
  normalizeRefSourceResponse
} from './workspace-source-normalization'

const SOURCE_READ_TIMEOUT_MS = 30_000
export const NEW_WORKSPACE_SOURCE_RESULT_LIMIT = 12

type SourceRead = { rows: NewWorkspaceSourceRow[]; warnings: string[] }
export type WorkspaceSourceSearchResult = SourceRead & { errors: string[] }

function responseResult(response: Awaited<ReturnType<RpcClient['sendRequest']>>): unknown {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return (response as RpcSuccess).result
}

async function readGitHub(client: RpcClient, repoId: string, query: string): Promise<SourceRead> {
  const response = await client.sendRequest(
    'github.listWorkItems',
    { repo: `id:${repoId}`, query: query || undefined, limit: NEW_WORKSPACE_SOURCE_RESULT_LIMIT },
    { timeoutMs: SOURCE_READ_TIMEOUT_MS }
  )
  return normalizeGitHubSourceResponse(responseResult(response), repoId)
}

async function readLinear(client: RpcClient, query: string): Promise<SourceRead> {
  const response = query
    ? await client.sendRequest(
        'linear.searchIssues',
        { query, limit: NEW_WORKSPACE_SOURCE_RESULT_LIMIT },
        { timeoutMs: SOURCE_READ_TIMEOUT_MS }
      )
    : await client.sendRequest(
        'linear.listIssues',
        { filter: 'assigned', limit: NEW_WORKSPACE_SOURCE_RESULT_LIMIT },
        { timeoutMs: SOURCE_READ_TIMEOUT_MS }
      )
  return normalizeLinearSourceResponse(responseResult(response))
}

async function readBranches(client: RpcClient, repoId: string, query: string): Promise<SourceRead> {
  const response = await client.sendRequest(
    'repo.searchRefs',
    { repo: `id:${repoId}`, query, limit: NEW_WORKSPACE_SOURCE_RESULT_LIMIT },
    { timeoutMs: SOURCE_READ_TIMEOUT_MS }
  )
  return { rows: normalizeRefSourceResponse(responseResult(response)), warnings: [] }
}

export async function searchWorkspaceSources(args: {
  client: RpcClient
  repoId: string
  query: string
  filter: NewWorkspaceSourceFilter
  availability: WorkspaceSourceAvailability
}): Promise<WorkspaceSourceSearchResult> {
  const query = args.query.trim()
  const reads: Array<{ kind: 'github' | 'branches' | 'linear'; read: Promise<SourceRead> }> = []
  if ((args.filter === 'all' || args.filter === 'github') && args.availability.github) {
    reads.push({ kind: 'github', read: readGitHub(args.client, args.repoId, query) })
  }
  if (
    (args.filter === 'all' || args.filter === 'branches') &&
    args.availability.branches &&
    (query.length > 0 || args.filter === 'branches')
  ) {
    reads.push({ kind: 'branches', read: readBranches(args.client, args.repoId, query) })
  }
  if ((args.filter === 'all' || args.filter === 'linear') && args.availability.linear) {
    reads.push({ kind: 'linear', read: readLinear(args.client, query) })
  }

  const settled = await Promise.allSettled(reads.map((entry) => entry.read))
  const rows: NewWorkspaceSourceRow[] = []
  const warnings: string[] = []
  const errors: string[] = []
  for (const [index, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      rows.push(...result.value.rows)
      warnings.push(...result.value.warnings)
    } else {
      const detail =
        result.reason instanceof Error ? result.reason.message : 'Source search failed.'
      errors.push(
        reads[index]?.kind === 'github' ? `${detail} GitHub runs on the selected host.` : detail
      )
    }
  }
  return { rows: rows.slice(0, NEW_WORKSPACE_SOURCE_RESULT_LIMIT), warnings, errors }
}

export async function resolveWorkspaceSourcePr(args: {
  client: RpcClient
  repoId: string
  item: {
    number: number
    branchName?: string
    baseRefName?: string
    isCrossRepository?: boolean
  }
}): Promise<GitHubPrStartPoint> {
  const response = await args.client.sendRequest(
    'worktree.resolvePrBase',
    {
      repo: `id:${args.repoId}`,
      prNumber: args.item.number,
      ...(args.item.branchName ? { headRefName: args.item.branchName } : {}),
      ...(args.item.baseRefName ? { baseRefName: args.item.baseRefName } : {}),
      ...(args.item.isCrossRepository !== undefined
        ? { isCrossRepository: args.item.isCrossRepository }
        : {})
    },
    { timeoutMs: SOURCE_READ_TIMEOUT_MS }
  )
  const result = responseResult(response)
  if (!result || typeof result !== 'object') {
    throw new Error('The selected host returned an incompatible PR start point.')
  }
  if ('error' in result && typeof result.error === 'string') {
    throw new Error(result.error)
  }
  if (!('baseBranch' in result) || typeof result.baseBranch !== 'string') {
    throw new Error('The selected host returned an incompatible PR start point.')
  }
  return result as GitHubPrStartPoint
}
