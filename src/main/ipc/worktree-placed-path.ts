import { getRuntimePathOps } from './worktree-logic'

/** Exact path for a multi-repo member; the caller still bounds it with ensurePathWithinWorkspace. */
export function computePlacedWorktreePath(
  placement: { parentDir: string; leafName: string },
  workspaceRoot: string
): string {
  return getRuntimePathOps(placement.parentDir, workspaceRoot).join(
    placement.parentDir,
    placement.leafName
  )
}
