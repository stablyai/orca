import type { OrcaRuntimeService } from '../../runtime/orca-runtime'

// Per host runtime, per client socket, per reporting window: the workspaces holding unsaved editor buffers.
const reportsByRuntime = new WeakMap<
  OrcaRuntimeService,
  Map<string, Map<string, ReadonlySet<string>>>
>()

/** Replaces what one client window reported; every report on a socket goes away when it closes. */
export function reportClientUnsavedEditors(
  runtime: OrcaRuntimeService,
  connectionId: string,
  reporterId: string,
  worktreeIds: readonly string[]
): void {
  let reports = reportsByRuntime.get(runtime)
  if (!reports) {
    reports = new Map()
    reportsByRuntime.set(runtime, reports)
  }
  let byReporter = reports.get(connectionId)
  if (!byReporter) {
    byReporter = new Map()
    reports.set(connectionId, byReporter)
    const owned = reports
    runtime.registerSubscriptionCleanup(
      `workspace-cleanup-unsaved-editors:${connectionId}`,
      () => {
        owned.delete(connectionId)
      },
      connectionId
    )
  }
  byReporter.set(reporterId, new Set(worktreeIds))
}

/** Workspaces any connected client has unsaved editor buffers in. */
export function listClientUnsavedEditorWorktreeIds(runtime: OrcaRuntimeService): Set<string> {
  const ids = new Set<string>()
  for (const byReporter of reportsByRuntime.get(runtime)?.values() ?? []) {
    for (const reported of byReporter.values()) {
      for (const id of reported) {
        ids.add(id)
      }
    }
  }
  return ids
}
