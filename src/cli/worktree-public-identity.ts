import type { RuntimeWorktreeListResult, RuntimeWorktreeRecord } from '../shared/runtime-types'
import { worktreeWorkspaceKey } from '../shared/workspace-scope'

export type PublicWorktreeRecord = RuntimeWorktreeRecord & { workspaceKey: string }

export function withPublicWorkspaceKey(worktree: RuntimeWorktreeRecord): PublicWorktreeRecord {
  return { ...worktree, workspaceKey: worktreeWorkspaceKey(worktree.id) }
}

export function withPublicWorkspaceKeys(
  result: RuntimeWorktreeListResult
): RuntimeWorktreeListResult & { worktrees: PublicWorktreeRecord[] } {
  return { ...result, worktrees: result.worktrees.map(withPublicWorkspaceKey) }
}

export function withPublicWorkspaceListResponse<
  TResponse extends { result: RuntimeWorktreeListResult }
>(response: TResponse): TResponse & { result: ReturnType<typeof withPublicWorkspaceKeys> } {
  return { ...response, result: withPublicWorkspaceKeys(response.result) }
}

export function withPublicWorkspaceRecordResponse<
  TResponse extends { result: { worktree: RuntimeWorktreeRecord } }
>(response: TResponse): TResponse & { result: { worktree: PublicWorktreeRecord } } {
  return { ...response, result: { worktree: withPublicWorkspaceKey(response.result.worktree) } }
}
