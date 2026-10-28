import { normalizeWindowsWslPath } from '../shared/windows-path-access'
import { parseWslUncPath } from '../shared/wsl-paths'

/** First use can install the selected distro's server before it registers the project. */
export function wslRegistrationCallOptions(
  resolvedPath: string,
  pathIsOnThisClient: boolean
): { timeoutMs: number } | undefined {
  return pathIsOnThisClient && parseWslUncPath(normalizeWindowsWslPath(resolvedPath))
    ? { timeoutMs: 10 * 60_000 }
    : undefined
}
