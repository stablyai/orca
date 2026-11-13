import type { OrcaRuntimeService } from '../../runtime/orca-runtime'

// Per host runtime, per client socket: the workspaces that client holds unsaved editor buffers in.
const reportsByRuntime = new WeakMap<OrcaRuntimeService, Map<string, ReadonlySet<string>>>()

/** Replaces what one client reported; its report goes away when its socket closes. */
export function reportClientUnsavedEditors(
  runtime: OrcaRuntimeService,
  connectionId: string,
  worktreeIds: readonly string[]
): void {
  let reports = reportsByRuntime.get(runtime)
  if (!reports) {
    reports = new Map()
    reportsByRuntime.set(runtime, reports)
  }
  if (!reports.has(connectionId)) {
    const owned = reports
    runtime.registerSubscriptionCleanup(
      `workspace-cleanup-unsaved-editors:${connectionId}`,
      () => {
        owned.delete(connectionId)
      },
      connectionId
    )
  }
  reports.set(connectionId, new Set(worktreeIds))
}

/** Workspaces any connected client has unsaved editor buffers in. */
export function listClientUnsavedEditorWorktreeIds(runtime: OrcaRuntimeService): Set<string> {
  const ids = new Set<string>()
  for (const reported of reportsByRuntime.get(runtime)?.values() ?? []) {
    for (const id of reported) {
      ids.add(id)
    }
  }
  return ids
}
