import type {
  LineageGetMembersResult,
  LineageGitStatusPayload
} from '../../shared/fleet-lineage-types'
import type { GitStatusResult } from '../../shared/git-status-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { getLineageStatus } from './lineage-git-status-service'
import { resolveLineageMembers } from './lineage-member-resolver'
import type { LineagePatternScanCache } from './lineage-pattern-scan-cache'
import type { LineageStoreContract } from './workspace-lineage-service'

export type LineageRequestDeps = {
  patternScanCache?: LineagePatternScanCache
  listWorktreesFn?: (repoPath: string) => Promise<GitWorktreeInfo[]>
  gitStatusFn?: (worktreePath: string) => Promise<GitStatusResult>
  worktreePathResolver?: (worktreeId: string, repoName: string, branch: string) => string | null
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? { ...value } : {}
}

function invalidStatus(error: string): LineageGitStatusPayload {
  return {
    status: 400,
    parentKey: '',
    parentWorkspaceKey: '',
    totalDirtyFiles: 0,
    projects: {},
    error
  }
}

// hazard: IPC payloads are untrusted at runtime despite the static types; never throw back to the renderer
export async function handleLineageStatusRequest(
  store: LineageStoreContract,
  args: unknown,
  deps: LineageRequestDeps = {}
): Promise<LineageGitStatusPayload> {
  const raw = readRecord(args)
  const key = raw.parentWorkspaceKey
  if (typeof key !== 'string' || key.length === 0) {
    return invalidStatus('parentWorkspaceKey must be a non-empty string')
  }
  const ticketKeys = raw.ticketKeys
  if (
    ticketKeys !== undefined &&
    (!Array.isArray(ticketKeys) || !ticketKeys.every((item) => typeof item === 'string'))
  ) {
    return invalidStatus('ticketKeys must be an array of strings')
  }
  try {
    return await getLineageStatus(store, key, {
      ...deps,
      ticketKeys,
      force: raw.force === true
    })
  } catch (error) {
    return {
      ...invalidStatus(error instanceof Error ? error.message : String(error)),
      status: 500,
      parentKey: key,
      parentWorkspaceKey: key
    }
  }
}

export async function handleLineageMembersRequest(
  store: LineageStoreContract,
  args: unknown,
  deps: LineageRequestDeps = {}
): Promise<LineageGetMembersResult> {
  const raw = readRecord(args)
  const key = typeof raw.parentWorkspaceKey === 'string' ? raw.parentWorkspaceKey : ''
  if (!key) {
    return { status: 200, parentWorkspaceKey: key, keys: [], members: [] }
  }
  const resolved = await resolveLineageMembers(store, key, { ...deps, force: raw.force === true })
  return { status: 200, parentWorkspaceKey: key, ...resolved }
}
