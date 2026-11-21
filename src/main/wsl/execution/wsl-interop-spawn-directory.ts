import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'

/** Use a stable system cwd: inherited worktrees can vanish, while WSL can keep a profile cwd busy after exit. */

let cachedSpawnCwd: string | null = null

function isExistingDirectory(path: string | undefined | null): path is string {
  if (!path) {
    return false
  }
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function resetWslInteropSpawnDirectoryCache(): void {
  cachedSpawnCwd = null
}

export function resolveWslInteropSpawnCwd(): string | undefined {
  if (isExistingDirectory(cachedSpawnCwd)) {
    return cachedSpawnCwd
  }
  const env = process.env
  const candidates: (string | undefined)[] = [
    env.SystemRoot,
    env.windir,
    env.SystemDrive ? `${env.SystemDrive}\\` : undefined,
    'C:\\',
    tmpdir()
  ]
  for (const candidate of candidates) {
    if (isExistingDirectory(candidate)) {
      cachedSpawnCwd = candidate
      return candidate
    }
  }
  cachedSpawnCwd = null
  // Fall back to inheritance only when no candidate directory exists.
  return undefined
}
