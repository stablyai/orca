import type {
  ScopedExternalAutomationRequest,
  ScopedExternalManagerActionRequest,
  ScopedExternalManagerListRequest
} from '../../shared/external-automation-scope'
import {
  resolveExternalAutomationScope,
  type DesktopSshTargetRegistry,
  type ResolvedExternalAutomationScope
} from './external-automation-owner-guard'
import {
  externalAutomationManagerCacheKey,
  type ExternalAutomationManagerCache,
  type ExternalAutomationManagerCacheEntry
} from './external-automation-manager-cache'
import type { ExternalAutomationProbeScheduler } from './external-automation-probe-scheduler'
import { listLocalManager } from './external-manager-discovery'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { runExternalAutomationAction } from './external-manager-mutations'

export { runExternalAutomationAction }

export type ScopedExternalAutomationDeps = {
  registry: DesktopSshTargetRegistry
  scheduler: ExternalAutomationProbeScheduler
  cache: ExternalAutomationManagerCache
}

export type ScopedExternalAutomations = {
  listManager: (
    request: ScopedExternalManagerListRequest
  ) => Promise<ExternalAutomationManagerCacheEntry>
  runAction: (request: ScopedExternalManagerActionRequest) => Promise<void>
}

/**
 * Scoped entry points: one captured desktop owner in, one host's managers out.
 * Every call re-resolves its scope before any probe, so a host that changed under
 * a held-open dialog fails closed instead of acting on the new incarnation.
 */
export function createScopedExternalAutomations(
  deps: ScopedExternalAutomationDeps
): ScopedExternalAutomations {
  const resolve = (request: ScopedExternalAutomationRequest): ResolvedExternalAutomationScope =>
    resolveExternalAutomationScope(request, deps.registry)
  return {
    async listManager(request) {
      const scope = resolve(request)
      const key = { ownerKey: scope.ownerKey, provider: scope.provider }
      return await deps.cache.resolve(
        key,
        () =>
          deps.scheduler.schedule({
            key: externalAutomationManagerCacheKey(key),
            scopeKey: scope.ownerKey,
            run: () =>
              scope.sshTarget
                ? Promise.reject(new SshHostNotServedError(scope.sshTarget.id))
                : listLocalManager(scope.provider)
          }),
        { refresh: request.refresh }
      )
    },
    async runAction(request) {
      const scope = resolve(request)
      await runExternalAutomationAction({
        managerId: scope.managerId,
        provider: scope.provider,
        target: scope.target,
        jobId: request.jobId,
        action: request.action
      })
      deps.cache.invalidateOwner(scope.ownerKey)
    }
  }
}
