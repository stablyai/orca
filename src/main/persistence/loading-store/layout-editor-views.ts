// Each editor tab's view (`WorkspaceLayout.editorViews`) beside the saved session, per partition,
// workspace key and tab id. A view is in memory only, so a command's apply, which loads the
// partition from its saved form, is seeded with them and keeps its result's; the projection
// publishes them. Never written to disk; layout-owner builds only.

import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { LayoutEditorView } from '../../../shared/workspace-layout/layout-editor-view'
import type { WorkspaceLayoutModel } from '../../../shared/workspace-layout/workspace-layout-model'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { StoreRuntimeState } from './store-runtime-state'

/** Workspace key → tab id → its view. */
export type PartitionEditorViews = Readonly<
  Record<string, Readonly<Record<string, LayoutEditorView>>>
>

type ViewsRuntime = Pick<StoreRuntimeState, 'layoutEditorViews'>

/** The partition's views to seed an apply with; undefined in a window-owned build (none kept). */
export function partitionEditorViewsOf(
  runtime: ViewsRuntime,
  hostId: ExecutionHostId
): PartitionEditorViews | undefined {
  // Switch point: a window-owned build keeps no view, so its applies change nothing.
  return ORCA_LAYOUT_OWNER_IS_MAIN ? (runtime.layoutEditorViews.get(hostId) ?? {}) : undefined
}

/** The views a model holds: a closed tab's are gone, a moved or rekeyed tab's under its new id. */
export function editorViewsOfModel(model: WorkspaceLayoutModel): PartitionEditorViews {
  const views: Record<string, Record<string, LayoutEditorView>> = {}
  for (const [key, workspace] of Object.entries(model.workspaces)) {
    if (workspace.editorViews && Object.keys(workspace.editorViews).length > 0) {
      views[key] = workspace.editorViews
    }
  }
  return views
}

/** Replaces the partition's views; the returned restore undoes it unless a later keep replaced them. */
export function keepPartitionEditorViews(
  runtime: ViewsRuntime,
  hostId: ExecutionHostId,
  views: PartitionEditorViews
): () => void {
  const before = runtime.layoutEditorViews.get(hostId) ?? {}
  runtime.layoutEditorViews.set(hostId, views)
  return () => {
    if (runtime.layoutEditorViews.get(hostId) === views) {
      runtime.layoutEditorViews.set(hostId, before)
    }
  }
}

/**
 * After a session write: a view whose tab left its place follows the tab to the one partition and
 * workspace now holding it (a partition move or rekey), and is dropped when none does (a removal).
 * An untouched partition keeps its object, so a pending apply's restore still recognises it.
 */
export function refileEditorViews(
  runtime: Pick<StoreRuntimeState, 'layoutEditorViews' | 'state'>
): void {
  // Runs on every session write: with no views held there is nothing to refile.
  if (runtime.layoutEditorViews.size === 0) {
    return
  }
  const edited = new Map<ExecutionHostId, Record<string, Record<string, LayoutEditorView>>>()
  const editable = (hostId: ExecutionHostId) => {
    let partition = edited.get(hostId)
    if (!partition) {
      const current = runtime.layoutEditorViews.get(hostId) ?? {}
      partition = Object.fromEntries(
        Object.entries(current).map(([key, views]) => [key, { ...views }])
      )
      edited.set(hostId, partition)
    }
    return partition
  }
  const strays: [string, LayoutEditorView][] = []
  for (const [hostId, partition] of runtime.layoutEditorViews) {
    const session = sessionOf(runtime, hostId)
    for (const [key, views] of Object.entries(partition)) {
      for (const [tabId, view] of Object.entries(views)) {
        if (!holdsEditorTab(session, key, tabId)) {
          strays.push([tabId, view])
          delete editable(hostId)[key]?.[tabId]
        }
      }
    }
  }
  for (const [tabId, view] of strays) {
    const places = placesHolding(runtime, tabId)
    const place = places.length === 1 ? places[0] : undefined
    const holder =
      place && (edited.get(place.hostId) ?? runtime.layoutEditorViews.get(place.hostId))
    if (place && !holder?.[place.key]?.[tabId]) {
      const partition = editable(place.hostId)
      partition[place.key] = { ...partition[place.key], [tabId]: view }
    }
  }
  for (const [hostId, partition] of edited) {
    const views = Object.fromEntries(
      Object.entries(partition).filter(([, tabs]) => Object.keys(tabs).length > 0)
    )
    if (Object.keys(views).length === 0) {
      runtime.layoutEditorViews.delete(hostId)
    } else {
      runtime.layoutEditorViews.set(hostId, views)
    }
  }
}

function sessionOf(
  runtime: Pick<StoreRuntimeState, 'state'>,
  hostId: ExecutionHostId
): WorkspaceSessionState | undefined {
  return hostId === LOCAL_EXECUTION_HOST_ID
    ? runtime.state.workspaceSession
    : runtime.state.workspaceSessionsByHostId?.[hostId]
}

function holdsEditorTab(
  session: WorkspaceSessionState | undefined,
  key: string,
  tabId: string
): boolean {
  return (
    session?.unifiedTabs?.[key]?.some(
      (tab) => tab.id === tabId && tab.contentType !== 'terminal'
    ) ?? false
  )
}

/** Every partition and workspace whose session holds editor tab `tabId`. */
function placesHolding(
  runtime: Pick<StoreRuntimeState, 'state'>,
  tabId: string
): { hostId: ExecutionHostId; key: string }[] {
  const hostIds = new Set<ExecutionHostId>([
    LOCAL_EXECUTION_HOST_ID,
    ...Object.keys(runtime.state.workspaceSessionsByHostId ?? {}).flatMap(
      (id) => normalizeExecutionHostId(id) ?? []
    )
  ])
  return [...hostIds].flatMap((hostId) => {
    const session = sessionOf(runtime, hostId)
    return Object.keys(session?.unifiedTabs ?? {})
      .filter((key) => holdsEditorTab(session, key, tabId))
      .map((key) => ({ hostId, key }))
  })
}
