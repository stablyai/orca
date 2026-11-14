import { parseExecutionHostId } from '../../shared/execution-host'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import { ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import type { AutomationService } from '../automations/automation-service'
import { createScopedExternalAutomations } from '../automations/external-managers/scoped-external-automations'
import {
  ExternalAutomationManagerCache,
  type ExternalAutomationManagerCacheEntry
} from '../automations/external-managers/external-automation-manager-cache'
import { ExternalAutomationProbeScheduler } from '../automations/external-managers/external-automation-probe-scheduler'
import { ownerKey } from '../../shared/automations/ownership/automation-owner-key'
import type { AutomationOwnerRef } from '../../shared/automations/ownership/automation-owner-ref'
import type {
  ScopedExternalManagerActionRequest,
  ScopedExternalManagerListRequest
} from '../../shared/external-automation-scope'

/** Refuse uncaptured owners instead of using the active host; malformed input remains a plain Error, not an ownership conflict. */
function requireCapturedOwner<T extends { owner?: AutomationOwnerRef | null }>(
  request: T | null | undefined
): T {
  const owner = request?.owner
  if (!request || !owner || !owner.authority || !owner.selector) {
    throw new Error('An automation owner is required for external automation requests.')
  }
  return request
}

/** Prioritize Orca work over queued external probes for the full operation lifetime. */
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
  // Cache TTL and probe concurrency need registration-long state, not per-request instances.
  const probeScheduler = new ExternalAutomationProbeScheduler()
  const managerCache = new ExternalAutomationManagerCache()
  const scopedExternal = createScopedExternalAutomations({
    // Let the guard reject hidden targets so filtering cannot change its error contract.
    registry: { getSshTargets: () => store.getSshTargets() },
    scheduler: probeScheduler,
    cache: managerCache
  })
  // Runtime RPC CRUD takes the service-installed priority lease.
  service.externalProbePriority = (run) => underOrcaPriority(probeScheduler, run)
  // Guard derives one host and manager ID from the captured owner.
  ipcMain.handle(
    'automations:listExternalManagerForOwner',
    (
      _event,
      request: ScopedExternalManagerListRequest
    ): Promise<ExternalAutomationManagerCacheEntry> =>
      scopedExternal.listManager(requireCapturedOwner(request))
  )
  ipcMain.handle(
    'automations:runExternalActionForOwner',
    (_event, request: ScopedExternalManagerActionRequest): Promise<void> =>
      scopedExternal.runAction(requireCapturedOwner(request))
  )
  // Cancel scopes no longer viewed; an empty retained set cancels all.
  ipcMain.handle(
    'automations:retainExternalScopes',
    (_event, request?: { owners?: readonly AutomationOwnerRef[] } | null): void => {
      probeScheduler.retainScopes((request?.owners ?? []).map(ownerKey))
    }
  )
  ipcMain.handle(
    'automations:snapshotWorkspaceName',
    (_event, args: { workspaceId: string; hostId?: string; displayName: string }): number => {
      const host = parseExecutionHostId(args.hostId)
      // No host, no label: a bare id would also relabel a same-id twin's runs.
      return host
        ? store.snapshotAutomationRunWorkspaceDisplayName(
            hostWorktreeTarget({ id: args.workspaceId, hostId: host.id }),
            args.displayName
          )
        : 0
    }
  )
}
