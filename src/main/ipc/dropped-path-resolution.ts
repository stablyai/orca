import { parseWslPath, toLinuxPath } from '../wsl'

export function resolveLocalDroppedPathsForAgent(paths: string[], worktreePath: string): string[] {
  // Local WSL shells need dropped Windows paths rewritten into their Linux namespace.
  const targetWsl = parseWslPath(worktreePath)
  return targetWsl
    ? paths.map((droppedPath) => resolveDroppedPathForTargetWsl(droppedPath, targetWsl.distro))
    : paths
}

function resolveDroppedPathForTargetWsl(droppedPath: string, targetDistro: string): string {
  const droppedWsl = parseWslPath(droppedPath)
  if (droppedWsl) {
    // Rewrite UNC paths only for their owning distro; another distro would receive a plausible wrong path.
    return isSameWslDistro(droppedWsl.distro, targetDistro) ? droppedWsl.linuxPath : droppedPath
  }
  return toLinuxPath(droppedPath)
}

function isSameWslDistro(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
}
