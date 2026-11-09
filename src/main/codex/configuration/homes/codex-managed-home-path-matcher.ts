import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import { parseWslUncPath } from '../../../../shared/wsl-paths'

/** Account storage stays private even when its ownership marker has been lost. */
export function matchesManagedCodexHomePath(
  configuredHome: string,
  targetHome: string,
  managedAccountsRoot: string
): boolean {
  const configuredKey = normalizeRuntimePathForComparison(configuredHome)
  const managedHomes = [targetHome, process.env.ORCA_CODEX_HOME?.trim()]
  if (
    managedHomes.some(
      (home) => home && normalizeRuntimePathForComparison(resolve(home)) === configuredKey
    )
  ) {
    return true
  }
  const wslSource = parseWslUncPath(configuredHome)
  if (wslSource && /\/\.local\/share\/orca\/codex-accounts(?:\/|$)/.test(wslSource.linuxPath)) {
    return true
  }
  const accountRoots = [
    managedAccountsRoot,
    join(homedir(), '.local', 'share', 'orca', 'codex-accounts')
  ]
  return accountRoots.some((root) => isPathInsideOrEqual(resolve(root), configuredHome))
}
