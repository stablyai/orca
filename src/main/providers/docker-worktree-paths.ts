import path from 'path'

export function parseWorktreePathFromId(worktreeId: string): string | null {
  const separatorIndex = worktreeId.indexOf('::')
  if (separatorIndex < 0) {
    return null
  }
  const worktreePath = worktreeId.slice(separatorIndex + 2)
  return worktreePath.length > 0 ? worktreePath : null
}

export function toDockerWorktreePath(
  hostPath: string | undefined,
  hostWorktreePath: string,
  containerWorkdir: string
): string | undefined {
  if (!hostPath) {
    return hostPath
  }
  const pathApi = usesWindowsPath(hostPath) || usesWindowsPath(hostWorktreePath) ? path.win32 : path
  const relativePath = pathApi.relative(hostWorktreePath, hostPath)
  if (!relativePath || relativePath === '.') {
    return containerWorkdir
  }
  if (
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    relativePath.startsWith('..\\') ||
    pathApi.isAbsolute(relativePath)
  ) {
    return hostPath
  }
  return path.posix.join(containerWorkdir, ...relativePath.split(/[\\/]+/))
}

function usesWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')
}
