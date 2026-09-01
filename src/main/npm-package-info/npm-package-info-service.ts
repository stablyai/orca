import type {
  NpmPackageInfoRequest,
  NpmPackageInfoResult
} from '../../shared/npm-package-info-types'
import type { Store } from '../persistence'
import { createNpmPackageInfoCache, type NpmPackageInfoCache } from './npm-package-info-cache'
import { npmRegistryHttpLookup } from './npm-registry-http-lookup'

export type NpmPackageInfoService = {
  lookup(request: NpmPackageInfoRequest): Promise<NpmPackageInfoResult>
}

/**
 * Orchestrates the privacy gate and cache/coalescing for a dependency metadata
 * lookup. Never throws: every failure mode resolves to one of
 * `NpmPackageInfoResult`'s explicit states.
 *
 * Why the public registry for every host rather than the local npm CLI: npm
 * reads its configuration from the workspace, and a checked-in `.npmrc` can
 * redirect it through `registry`, a scoped `@scope:registry`, `proxy`,
 * `https-proxy`, `cafile` or `strict-ssl`. Validating those keys one by one is
 * not a containment — the list is not enumerable. Honouring `.npmrc` for
 * private registries needs an explicit workspace-trust decision first, the way
 * VS Code gates its npm extension behind `workspace.isTrusted`.
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
      return cache.getOrRun(cacheKey, () => npmRegistryHttpLookup(request.packageName))
    }
  }
}
