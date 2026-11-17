import type { RuntimeWorktreeRecord } from '../../shared/runtime-worktree-contracts'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { RuntimeClientError } from '../runtime/types'

/** One workspace the cwd rule can pick: a repo-backed row or a group-level folder keyed `folder:<id>`. */
export type CatalogRow = Pick<RuntimeWorktreeRecord, 'id' | 'path' | 'hostId'> & {
  identity?: { key: string }
  repoId?: string
  /** A folder workspace whose owning host couldn't be derived; it may be the caller's, so it counts. */
  hostUnresolved?: true
}

/** An innermost folder with an unknown host can't be ruled in or out, so no owner is guessed. */
export function refuseUnresolvedOwner(innermost: readonly CatalogRow[]): void {
  const unresolved = innermost.filter((row) => row.hostUnresolved)
  if (unresolved.length === 0) {
    return
  }
  throw new RuntimeClientError(
    'selector_ambiguous',
    `Orca can't tell which host owns the folder workspace containing the current directory (${unresolved.map((row) => `${row.id} at ${row.path}`).join(', ')}), so it won't guess the workspace.`,
    {
      workspaces: innermost.map((row) => ({
        kind: parseWorkspaceKey(row.id)?.type === 'folder' ? 'folder workspace' : 'worktree',
        id: row.id,
        path: row.path,
        hostId: row.hostUnresolved ? null : (row.hostId ?? 'local')
      })),
      nextSteps: [
        ...unresolved.map(
          (row) => `Pass --worktree ${row.id} to target the folder workspace itself.`
        ),
        'Or pass an explicit worktree selector from `orca worktree ps --json`.'
      ]
    }
  )
}
