import { isAbsolute } from 'node:path'
import { parseExecutionHostId } from '../../shared/execution-host'
import type {
  NpmPackageInfo,
  NpmPackageInfoRequest,
  NpmPackageInfoResult
} from '../../shared/npm-package-info-types'
import { resolveRegisteredWorktreePath } from '../ipc/registered-worktree-roots-cache'
import type { Store } from '../persistence'
import { isWorkspaceTrusted } from '../workspace-trust/workspace-trust-service'
import { npmCliPackageView } from './npm-cli-package-view'
import { createNpmPackageInfoCache, type NpmPackageInfoCache } from './npm-package-info-cache'
import { npmRegistryHttpLookup } from './npm-registry-http-lookup'

export type NpmPackageInfoService = {
  lookup(request: NpmPackageInfoRequest): Promise<NpmPackageInfoResult>
}

type LocalWorktreeAuthorization =
  /** Authorized and trusted; `cwd` is the resolved root the CLI may run in. */
  | { kind: 'trusted'; cwd: string }
  | { kind: 'untrusted' }
  /** Not this machine's filesystem, so no local trust entry can apply. */
  | { kind: 'not-local' }
  | { kind: 'rejected' }

/**
 * Authorize the renderer-supplied root, then ask trust about the authorized
 * path — never about the string that arrived. Both steps run before the cache
 * because the trust class they produce is part of the cache key.
 */
async function authorizeLocalWorktree(
  request: NpmPackageInfoRequest,
  store: Store
): Promise<LocalWorktreeAuthorization> {
  if (parseExecutionHostId(request.executionHostId)?.kind !== 'local') {
    return { kind: 'not-local' }
  }
  // Why absoluteness first: `resolveRegisteredWorktreePath` calls `resolve()`,
  // which would silently reinterpret a relative root against the main
  // process's own cwd — a directory the renderer never named, and one that can
  // itself be registered and trusted.
  if (!isAbsolute(request.worktreeRoot)) {
    return { kind: 'rejected' }
  }
  let cwd: string
  try {
    cwd = await resolveRegisteredWorktreePath(request.worktreeRoot, store)
  } catch {
    return { kind: 'rejected' }
  }
  // `isWorkspaceTrusted`, never `getWorkspaceTrustDecision`: only the former
  // re-verifies the match canonically, and only it refuses to report an
  // undecided path as anything but untrusted.
  return (await isWorkspaceTrusted(cwd, store)) ? { kind: 'trusted', cwd } : { kind: 'untrusted' }
}

/** Why a remote host gets no reason: it never had the CLI to lose, so naming one would report a degradation that did not happen. */
function fallbackReasonFor(
  authorization: LocalWorktreeAuthorization
): NpmPackageInfo['sourceReason'] {
  switch (authorization.kind) {
    case 'untrusted':
      return 'workspace-untrusted'
    case 'trusted':
      // Reached only after the CLI reported itself unresolvable.
      return 'npm-unavailable'
    case 'not-local':
    case 'rejected':
      return undefined
  }
}

/** Copies rather than mutates: the lookup's result object may be shared with the cache and other callers. */
function withSourceReason(
  result: NpmPackageInfoResult,
  reason: NpmPackageInfo['sourceReason']
): NpmPackageInfoResult {
  if (!reason || result.status !== 'ok') {
    return result
  }
  return { status: 'ok', info: { ...result.info, sourceReason: reason } }
}

/**
 * Orchestrates the privacy gate, the workspace-trust gate, and cache/coalescing
 * for a dependency metadata lookup. Never throws: every failure mode resolves
 * to one of `NpmPackageInfoResult`'s explicit states.
 *
 * Why trust decides the source: npm reads its configuration from the workspace,
 * and a checked-in `.npmrc` can redirect it through `registry`, a scoped
 * `@scope:registry`, `proxy`, `https-proxy`, `cafile` or `strict-ssl`.
 * Validating those keys one by one is not a containment — the list is not
 * enumerable. Honouring `.npmrc` is safe only where the user vouched for the
 * location, the way VS Code gates its npm extension behind `workspace.isTrusted`.
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

      const authorization = await authorizeLocalWorktree(request, store)
      if (authorization.kind === 'rejected') {
        return { status: 'unavailable', reason: 'host-unresolved' }
      }

      // Why the trust class leads the key: unlike the privacy flag, a trusted
      // lookup DOES populate the cache, with private-registry-derived data. A
      // shared key would keep serving that to a workspace whose trust was
      // revoked; separate keys make a flip structurally unable to hit it.
      const trustClass = authorization.kind === 'trusted' ? 'cli' : 'http'
      const cacheKey = `${trustClass}\0${request.executionHostId}\0${request.packageName}`
      return cache.getOrRun(cacheKey, async () => {
        if (authorization.kind === 'trusted') {
          const cliResult = await npmCliPackageView(request.packageName, authorization.cwd)
          if (cliResult.status !== 'npm-unresolvable') {
            return cliResult
          }
          // A trusted host with no resolvable npm binary falls back to the
          // public registry rather than reporting the lookup unavailable.
        }
        const httpResult = await npmRegistryHttpLookup(request.packageName)
        return withSourceReason(httpResult, fallbackReasonFor(authorization))
      })
    }
  }
}
