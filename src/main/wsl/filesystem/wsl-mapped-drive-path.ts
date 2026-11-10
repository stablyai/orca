import { realpath } from 'node:fs/promises'
import { parseWslUncPath } from '../../../shared/wsl-paths'

/** Preserve ordinary drives, but expose a drive mapped to a WSL share as its canonical UNC path. */
export async function resolveWslMappedDrivePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
  resolveRealPath: (path: string) => Promise<string> = realpath
): Promise<string> {
  if (platform !== 'win32' || !/^[A-Za-z]:[\\/]/.test(path)) {
    return path
  }
  try {
    const resolved = await resolveRealPath(path)
    return parseWslUncPath(resolved) ? resolved : path
  } catch {
    return path
  }
}
