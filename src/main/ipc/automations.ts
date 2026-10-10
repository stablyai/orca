import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { AutomationService } from '../automations/service'
import type {
  AutomationDispatchResult,
  AutomationPrecheckResult,
  ExternalAutomationRunsPage,
  AutomationRun
} from '../../shared/automations-types'
import { createScopedExternalAutomations } from '../automations/external-manager'
import {
  ExternalAutomationManagerCache,
  type ExternalAutomationManagerCacheEntry
} from '../automations/external-automation-manager-cache'
import { ExternalAutomationProbeScheduler } from '../automations/external-automation-probe-scheduler'
import { ownerKey } from '../../shared/automation-owner-key'
import type { AutomationOwnerRef } from '../../shared/automation-owner-ref'
import type {
  ScopedExternalManagerActionRequest,
  ScopedExternalManagerCreateRequest,
  ScopedExternalManagerListRequest,
  ScopedExternalManagerRunsRequest,
  ScopedExternalManagerUpdateRequest
} from '../../shared/external-automation-scope'

/**
 * Fail closed: an external request with no captured owner is refused rather than
 * resolved against whichever host happens to be active. Malformed input keeps
 * the engine's plain-Error convention; it is not an ownership *conflict*.
 */
function requireCapturedOwner<T extends { owner?: AutomationOwnerRef | null }>(
  request: T | null | undefined
): T {
  const owner = request?.owner
  if (!request || !owner || !owner.authority || !owner.selector) {
    throw new Error('An automation owner is required for external automation requests.')
  }
  return request
}

/**
 * Holds the probe pool's priority lease for the duration of Orca's own automation
 * work. Without this, a queued external probe competes with the list and mutation
 * traffic the user is actually waiting on.
 */
function underOrcaPriority<T>(scheduler: ExternalAutomationProbeScheduler, run: () => T): T {
  const release = scheduler.beginPriorityWork()
  let pending = false
  try {
    const result = run()
    if (result instanceof Promise) {
      pending = true
      return result.finally(release) as T
    }
    return result
  } finally {
    if (!pending) {
      release()
    }
  }
}

export function registerAutomationHandlers(store: Store, service: AutomationService): void {
  // One long-lived pair per registration: the cache TTL and the probe pool's
  // concurrency ceiling only mean anything if they outlive a single request.
  const probeScheduler = new ExternalAutomationProbeScheduler()
  const managerCache = new ExternalAutomationManagerCache()
  const scopedExternal = createScopedExternalAutomations({
    // Hidden runtime-owned targets are passed through on purpose: the guard
    // rejects them itself, so pre-filtering here would leak a different error.
    registry: { getSshTargets: () => store.getSshTargets() },
    scheduler: probeScheduler,
    cache: managerCache
  })
  // Why: Orca automation CRUD now arrives over the local runtime RPC surface,
  // so the runtime methods take the lease through this hook instead of an arm here.
  service.externalProbePriority = (run) => underOrcaPriority(probeScheduler, run)
  // Scoped external-manager surface: one captured desktop owner in, one host's
  // managers out. The target and manager ID are derived inside the guard.
  ipcMain.handle(
    'automations:listExternalManagerForOwner',
    (
      _event,
      request: ScopedExternalManagerListRequest
    ): Promise<ExternalAutomationManagerCacheEntry> =>
      scopedExternal.listManager(requireCapturedOwner(request))
  )
  ipcMain.handle(
    'automations:listExternalRunsForOwner',
    (_event, request: ScopedExternalManagerRunsRequest): Promise<ExternalAutomationRunsPage> =>
      scopedExternal.listRuns(requireCapturedOwner(request))
  )
  ipcMain.handle(
    'automations:createExternalForOwner',
    (_event, request: ScopedExternalManagerCreateRequest): Promise<void> =>
      scopedExternal.create(requireCapturedOwner(request))
  )
  ipcMain.handle(
    'automations:updateExternalForOwner',
    (_event, request: ScopedExternalManagerUpdateRequest): Promise<void> =>
      scopedExternal.update(requireCapturedOwner(request))
  )
  ipcMain.handle(
    'automations:runExternalActionForOwner',
    (_event, request: ScopedExternalManagerActionRequest): Promise<void> =>
      scopedExternal.runAction(requireCapturedOwner(request))
  )
  // Why: probes for hosts the user is no longer viewing are cancelled, not left
  // to finish. An empty list retains nothing, which is the correct fail-closed
  // state for a renderer with no desktop scope selected.
  ipcMain.handle(
    'automations:retainExternalScopes',
    (_event, request?: { owners?: readonly AutomationOwnerRef[] } | null): void => {
      probeScheduler.retainScopes((request?.owners ?? []).map(ownerKey))
    }
  )
  ipcMain.handle(
    'automations:runPrecheck',
    (
      _event,
      args: { automationId: string; runId: string }
    ): Promise<AutomationPrecheckResult | null> =>
      service.runPrecheck(args.automationId, args.runId)
  )
  ipcMain.handle(
    'automations:markDispatchResult',
    (_event, result: AutomationDispatchResult): Promise<AutomationRun> =>
      service.markDispatchResult(result)
  )
  ipcMain.handle(
    'automations:snapshotWorkspaceName',
    (_event, args: { workspaceId: string; displayName: string }): number =>
      store.snapshotAutomationRunWorkspaceDisplayName(args.workspaceId, args.displayName)
  )
  ipcMain.handle('automations:rendererReady', (): void => {
    service.setRendererReady()
  })
}
