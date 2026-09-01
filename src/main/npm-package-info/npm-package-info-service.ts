import { parseExecutionHostId } from '../../shared/execution-host'
import type {
  NpmPackageInfoRequest,
  NpmPackageInfoResult
} from '../../shared/npm-package-info-types'
import type { Store } from '../persistence'
import { npmCliPackageView } from './npm-cli-package-view'
import { createNpmPackageInfoCache, type NpmPackageInfoCache } from './npm-package-info-cache'
import { npmRegistryHttpLookup } from './npm-registry-http-lookup'

export type NpmPackageInfoService = {
  lookup(request: NpmPackageInfoRequest): Promise<NpmPackageInfoResult>
}

/**
 * Orchestrates the privacy gate, host branch, and cache/coalescing for a
 * dependency metadata lookup. Never throws: every failure mode resolves to
 * one of `NpmPackageInfoResult`'s explicit states.
 */
export function createNpmPackageInfoService(
  store: Store,
  cache: NpmPackageInfoCache = createNpmPackageInfoCache()
): NpmPackageInfoService {
  return {
    async lookup(request: NpmPackageInfoRequest): Promise<NpmPackageInfoResult> {
      // Why re-read on every call rather than cache the flag: the setting can
      // flip between lookups, and this ordering — gate before cache — is what
      // makes an explicit "clear cache on flip" step unnecessary: a disabled
      // lookup never reaches (and therefore never pollutes) the cache.
      const onlineLookupsEnabled = store.getSettings().npmPackageInfoOnlineLookupsEnabled ?? true
      if (!onlineLookupsEnabled) {
        return { status: 'lookup-disabled' }
      }

      const cacheKey = `${request.executionHostId}\0${request.packageName}`
      return cache.getOrRun(cacheKey, async () => {
        const host = parseExecutionHostId(request.executionHostId)
        if (host?.kind === 'local') {
          const cliResult = await npmCliPackageView(
            request.packageName,
            request.worktreeRoot,
            store
          )
          if (cliResult.status !== 'npm-unresolvable') {
            return cliResult
          }
          // Local host with no resolvable npm binary: fall back to the public
          // registry over HTTP (VS Code does the same) rather than reporting
          // the lookup unavailable.
        }
        return npmRegistryHttpLookup(request.packageName)
      })
    }
  }
}
