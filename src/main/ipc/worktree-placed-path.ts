import { computeWorktreePath, ensurePathWithinWorkspace, getRuntimePathOps } from './worktree-logic'

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

/** A placed member lives under its group root, which a per-project base path need not contain. */
export function resolveCandidateWorktreePath(args: {
  placement: { parentDir: string; leafName: string } | undefined
  sanitizedName: string
  repoPath: string
  workspaceRoot: string
  worktreePathSettings: Parameters<typeof computeWorktreePath>[2]
}): string {
  return args.placement
    ? ensurePathWithinWorkspace(
        computePlacedWorktreePath(args.placement, args.workspaceRoot),
        args.placement.parentDir
      )
    : ensurePathWithinWorkspace(
        computeWorktreePath(args.sanitizedName, args.repoPath, args.worktreePathSettings),
        args.workspaceRoot
      )
}
