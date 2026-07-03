import { parseWslPath, toLinuxPath } from '../wsl'

export function resolveLocalDroppedPathsForAgent(paths: string[], worktreePath: string): string[] {
  // Why: a local WSL PTY runs inside Linux, so Windows drop paths must be
  // rewritten to paths the shell and agent can read.
  const targetWsl = parseWslPath(worktreePath)
  return targetWsl
    ? paths.map((droppedPath) => resolveDroppedPathForTargetWsl(droppedPath, targetWsl.distro))
    : paths
}

function resolveDroppedPathForTargetWsl(droppedPath: string, targetDistro: string): string {
  const droppedWsl = parseWslPath(droppedPath)
  if (droppedWsl) {
    // Why: WSL UNC paths are only Linux-native inside their own distro.
    // Rewriting another distro would paste a plausible but wrong path.
    return isSameWslDistro(droppedWsl.distro, targetDistro) ? droppedWsl.linuxPath : droppedPath
  }
  return toLinuxPath(droppedPath)
}

function isSameWslDistro(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
}
