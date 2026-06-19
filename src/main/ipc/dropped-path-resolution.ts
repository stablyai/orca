import { parseWslPath, toLinuxPath } from '../wsl'

export function resolveLocalDroppedPathsForAgent(paths: string[], worktreePath: string): string[] {
  // Why: a local WSL PTY runs inside Linux, so Windows drop paths must be
  // rewritten to paths the shell and agent can read.
  return parseWslPath(worktreePath) ? paths.map((droppedPath) => toLinuxPath(droppedPath)) : paths
}
