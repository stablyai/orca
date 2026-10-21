import { app } from 'electron'
import { join, normalize, sep } from 'node:path'
import { isAppBackgroundImageId } from '../../shared/app-background-settings'

export function getAppBackgroundDir(): string {
  return join(app.getPath('userData'), 'appearance')
}

// Why: staging lives under the same root so commit is a same-volume rename, never a copy.
export function getAppBackgroundStagingDir(): string {
  return join(getAppBackgroundDir(), '.staging')
}

/** Resolves a background image id to its file, or null when the id could escape the directory. */
export function resolveAppBackgroundImageFile(id: string, staging: boolean): string | null {
  if (!isAppBackgroundImageId(id)) {
    return null
  }
  const root = normalize(staging ? getAppBackgroundStagingDir() : getAppBackgroundDir())
  const filePath = normalize(join(root, id))
  // Why: backstop for the id regex — the resolved file must sit directly in the root.
  if (!filePath.startsWith(root + sep) || filePath.slice(root.length + 1) !== id) {
    return null
  }
  return filePath
}
