import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'

/** Use a stable system cwd: inherited worktrees can vanish, while WSL can keep a profile cwd busy after exit. */

let cachedSpawnCwd: string | null = null

function candidateDirectories(): (string | undefined)[] {
  const env = process.env
  return [
    env.SystemRoot,
    env.windir,
    env.SystemDrive ? `${env.SystemDrive}\\` : undefined,
    'C:\\',
    tmpdir()
  ]
}

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

async function isExistingDirectoryAsync(path: string | undefined | null): Promise<boolean> {
  if (!path) {
    return false
  }
  try {
    return (await stat(path)).isDirectory()
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
  for (const candidate of candidateDirectories()) {
    if (isExistingDirectory(candidate)) {
      cachedSpawnCwd = candidate
      return candidate
    }
  }
  cachedSpawnCwd = null
  // Fall back to inheritance only when no candidate directory exists.
  return undefined
}

export async function resolveWslInteropSpawnCwdAsync(): Promise<string | undefined> {
  if (cachedSpawnCwd && (await isExistingDirectoryAsync(cachedSpawnCwd))) {
    return cachedSpawnCwd
  }
  for (const candidate of candidateDirectories()) {
    if (candidate && (await isExistingDirectoryAsync(candidate))) {
      cachedSpawnCwd = candidate
      return candidate
    }
  }
  cachedSpawnCwd = null
  return undefined
}
