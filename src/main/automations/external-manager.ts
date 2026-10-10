import type {
  ExternalAutomationCreateInput,
  ExternalAutomationRunsPage
} from '../../shared/automations-types'
import type {
  ScopedExternalAutomationRequest,
  ScopedExternalManagerActionRequest,
  ScopedExternalManagerCreateRequest,
  ScopedExternalManagerListRequest,
  ScopedExternalManagerMutationFields,
  ScopedExternalManagerRunsRequest,
  ScopedExternalManagerUpdateRequest
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
import { listLocalManager, listRemoteManager } from './external-manager-discovery'
import {
  createExternalAutomation,
  runExternalAutomationAction,
  updateExternalAutomation
} from './external-manager-mutations'
import { listExternalAutomationRuns } from './external-manager-runs'

export {
  createExternalAutomation,
  listExternalAutomationRuns,
  runExternalAutomationAction,
  updateExternalAutomation
}

export type ScopedExternalAutomationDeps = {
  registry: DesktopSshTargetRegistry
  scheduler: ExternalAutomationProbeScheduler
  cache: ExternalAutomationManagerCache
}

export type ScopedExternalAutomations = {
  listManager: (
    request: ScopedExternalManagerListRequest
  ) => Promise<ExternalAutomationManagerCacheEntry>
  listRuns: (request: ScopedExternalManagerRunsRequest) => Promise<ExternalAutomationRunsPage>
  create: (request: ScopedExternalManagerCreateRequest) => Promise<void>
  update: (request: ScopedExternalManagerUpdateRequest) => Promise<void>
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
  const mutationInput = (
    scope: ResolvedExternalAutomationScope,
    fields: ScopedExternalManagerMutationFields
  ): ExternalAutomationCreateInput => ({
    managerId: scope.managerId,
    provider: scope.provider,
    target: scope.target,
    name: fields.name,
    prompt: fields.prompt,
    schedule: fields.schedule,
    workdir: fields.workdir
  })

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
                ? listRemoteManager(scope.sshTarget, scope.provider)
                : listLocalManager(scope.provider)
          }),
        { refresh: request.refresh }
      )
    },
    async listRuns(request) {
      const scope = resolve(request)
      return await listExternalAutomationRuns({
        managerId: scope.managerId,
        provider: scope.provider,
        target: scope.target,
        jobId: request.jobId,
        page: request.page,
        pageSize: request.pageSize
      })
    },
    async create(request) {
      const scope = resolve(request)
      await createExternalAutomation(mutationInput(scope, request))
      deps.cache.invalidateOwner(scope.ownerKey)
    },
    async update(request) {
      const scope = resolve(request)
      await updateExternalAutomation({ ...mutationInput(scope, request), jobId: request.jobId })
      deps.cache.invalidateOwner(scope.ownerKey)
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
