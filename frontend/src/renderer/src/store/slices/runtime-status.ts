import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import {
  clearRecentRuntimeCompatibilityFailure,
  getActiveRuntimeTarget,
  unwrapRuntimeRpcResult
} from '@/runtime/runtime-rpc-client'
import { runtimeClientState } from '@/runtime/runtime-client-state-client'

/** Live status for one saved runtime environment, as last observed by the
 * renderer. `status === null` records a probe that failed or timed out so the
 * sidebar can still distinguish "unknown/unreachable" from "never checked". */
export type RuntimeEnvironmentStatus = {
  status: RuntimeStatus | null
  appVersion?: string | null
  checkedAt: number
}

export type RuntimeStatusSlice = {
  /** Saved remote Orca servers. Host pickers use this to show user-chosen names
   * instead of opaque runtime ids. */
  runtimeEnvironments: PublicKnownRuntimeEnvironment[]
  /** Keyed by runtime environment id. Fed into buildExecutionHostRegistry so
   * compat verdicts/blocked health show live in the sidebar host pickers. */
  runtimeStatusByEnvironmentId: Map<string, RuntimeEnvironmentStatus>
  /** Replaces the saved-environment list and trims stale status entries. */
  setRuntimeEnvironments: (environments: PublicKnownRuntimeEnvironment[]) => void
  /** Merges one environment's status. Replaces the prior entry for that id. */
  setRuntimeEnvironmentStatus: (environmentId: string, status: RuntimeEnvironmentStatus) => void
  /** Drops a removed environment so stale hosts don't linger in the registry. */
  clearRuntimeEnvironmentStatus: (environmentId: string) => void
  /** Drops every entry whose id is not in the saved-environments set. */
  retainRuntimeEnvironmentStatuses: (environmentIds: Iterable<string>) => void
  /** Probes one saved runtime and records the latest reachable/unreachable state. */
  refreshRuntimeEnvironmentStatus: (environmentId: string, timeoutMs?: number) => Promise<boolean>
  /** Best-effort: list saved environments and probe each so the sidebar shows
   * live health at boot, before the settings pane is ever opened. */
  hydrateRuntimeEnvironmentStatuses: () => Promise<void>
}

// Why (FE-TASK-STORAGE-003): remote does not overwrite a local deletion —
// a saved-environment removed on this machine but not yet synced from
// another machine's backend-go copy must stay removed here. Remote only adds
// entries local doesn't have yet (e.g. added from another machine).
export function mergeById(
  local: PublicKnownRuntimeEnvironment[],
  remote: PublicKnownRuntimeEnvironment[]
): PublicKnownRuntimeEnvironment[] {
  const localIds = new Set(local.map((environment) => environment.id))
  const additions = remote.filter((environment) => !localIds.has(environment.id))
  return additions.length === 0 ? local : [...local, ...additions]
}

export const createRuntimeStatusSlice: StateCreator<AppState, [], [], RuntimeStatusSlice> = (
  set,
  get
) => ({
  runtimeEnvironments: [],
  runtimeStatusByEnvironmentId: new Map(),

  setRuntimeEnvironments: (environments) => {
    set((s) => {
      const keep = new Set(environments.map((environment) => environment.id))
      const nextStatuses = new Map(s.runtimeStatusByEnvironmentId)
      let statusesChanged = false
      for (const id of nextStatuses.keys()) {
        if (!keep.has(id)) {
          nextStatuses.delete(id)
          statusesChanged = true
        }
      }
      return {
        runtimeEnvironments: environments,
        ...(statusesChanged ? { runtimeStatusByEnvironmentId: nextStatuses } : {})
      }
    })
    // Why: evict detected-agent caches for environments that no longer exist so
    // they don't leak per-environment entries for the renderer session.
    // Optional-chained: minimal store assemblies (some unit tests) omit the
    // detected-agents slice.
    get().retainRuntimeDetectedAgents?.(environments.map((environment) => environment.id))
    // A detached environment's mirrored SSH state must not outlive it.
    get().retainEnvironmentSshState?.(environments.map((environment) => environment.id))
    // FE-TASK-STORAGE-003: mirror the saved-environment list to backend-go so
    // it survives switching machines. Fire-and-forget — this is the single
    // mutation point for the list (add/remove/pairing all funnel through
    // here), so one call site covers every caller.
    const target = getActiveRuntimeTarget(get().settings)
    if (target.kind === 'environment') {
      void runtimeClientState.set('savedRuntimeEnvironments', environments).catch((error) => {
        console.error('Failed to persist saved runtime environments to backend-go:', error)
      })
    }
  },

  setRuntimeEnvironmentStatus: (environmentId, status) => {
    // Why: a non-null status proves the runtime just answered, so drop any stale
    // "offline" compat failure before this online transition fires the
    // reuse-flagged background refetches — a recovered host must re-probe.
    if (status.status !== null) {
      clearRecentRuntimeCompatibilityFailure(environmentId)
    }
    set((s) => {
      const next = new Map(s.runtimeStatusByEnvironmentId)
      next.set(environmentId, status)
      return { runtimeStatusByEnvironmentId: next }
    })
  },

  clearRuntimeEnvironmentStatus: (environmentId) =>
    set((s) => {
      if (!s.runtimeStatusByEnvironmentId.has(environmentId)) {
        return s
      }
      const next = new Map(s.runtimeStatusByEnvironmentId)
      next.delete(environmentId)
      return { runtimeStatusByEnvironmentId: next }
    }),

  retainRuntimeEnvironmentStatuses: (environmentIds) =>
    set((s) => {
      const keep = new Set(environmentIds)
      let changed = false
      const next = new Map(s.runtimeStatusByEnvironmentId)
      for (const id of next.keys()) {
        if (!keep.has(id)) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? { runtimeStatusByEnvironmentId: next } : s
    }),

  refreshRuntimeEnvironmentStatus: async (environmentId, timeoutMs = 10_000) => {
    try {
      const response = await window.api.runtimeEnvironments.getStatus({
        selector: environmentId,
        timeoutMs
      })
      const status = unwrapRuntimeRpcResult<RuntimeStatus>(response)
      // setRuntimeEnvironmentStatus drops any stale compat failure on a non-null
      // (reachable) status, so a recovered host's reuse-flagged refetches re-probe.
      get().setRuntimeEnvironmentStatus(environmentId, { status, checkedAt: Date.now() })
      return true
    } catch {
      get().setRuntimeEnvironmentStatus(environmentId, {
        status: null,
        checkedAt: Date.now()
      })
      return false
    }
  },

  hydrateRuntimeEnvironmentStatuses: async () => {
    let environments: PublicKnownRuntimeEnvironment[]
    try {
      environments = await window.api.runtimeEnvironments.list()
    } catch (err) {
      console.error('Failed to list runtime environments for status hydration:', err)
      return
    }
    // FE-TASK-STORAGE-003: merge in anything saved to backend-go from another
    // machine. Best-effort — a failed/unreachable backend-go must not block
    // showing the locally-known saved environments.
    const target = getActiveRuntimeTarget(get().settings)
    if (target.kind === 'environment') {
      try {
        const remote = await runtimeClientState.get<PublicKnownRuntimeEnvironment[]>(
          'savedRuntimeEnvironments'
        )
        if (remote) {
          environments = mergeById(environments, remote)
        }
      } catch (err) {
        console.error('Failed to load saved runtime environments from backend-go:', err)
      }
    }
    get().setRuntimeEnvironments(environments)
    // Why: fire-and-forget per env; one unreachable server must not block the
    // others, and a failure records a null status rather than nothing.
    await Promise.allSettled(
      environments.map((environment) => get().refreshRuntimeEnvironmentStatus(environment.id))
    )
  }
})
