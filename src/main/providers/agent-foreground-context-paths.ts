import { splitWorktreeIdForFilesystem } from '../../shared/worktree-id'

export function getAgentForegroundContextPaths(options: {
  cwd?: string
  worktreeId?: string | null
}): string[] {
  const worktreePath = options.worktreeId
    ? splitWorktreeIdForFilesystem(options.worktreeId)?.worktreePath
    : undefined
  return [...new Set([options.cwd, worktreePath].filter((path): path is string => Boolean(path)))]
}
