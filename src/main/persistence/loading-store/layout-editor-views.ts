// Keep editor views in memory through partition applies and tab moves; never serialize them.

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
import { sessionPublication } from './session-publication'
import type { SessionChangeSet } from '../../../shared/session-change-set'

export type PartitionEditorViews = Readonly<
  Record<string, Readonly<Record<string, LayoutEditorView>>>
>

type ViewsRuntime = Pick<StoreRuntimeState, 'layoutEditorViews'>

/** Window-owned builds retain no main-process views. */
export function partitionEditorViewsOf(
  runtime: ViewsRuntime,
  hostId: ExecutionHostId
): PartitionEditorViews | undefined {
  return ORCA_LAYOUT_OWNER_IS_MAIN ? (runtime.layoutEditorViews.get(hostId) ?? {}) : undefined
}

export function editorViewsOfModel(model: WorkspaceLayoutModel): PartitionEditorViews {
  const views: Record<string, Record<string, LayoutEditorView>> = {}
  for (const [key, workspace] of Object.entries(model.workspaces)) {
    if (workspace.editorViews && Object.keys(workspace.editorViews).length > 0) {
      views[key] = workspace.editorViews
    }
  }
  return views
}

type ViewPlace = { hostId: ExecutionHostId; key: string }
type ViewIndex = Map<string, Map<ExecutionHostId, Set<string>>>
const viewIndexes = new WeakMap<ViewsRuntime['layoutEditorViews'], ViewIndex>()

function addViewPlace(index: ViewIndex, tabId: string, place: ViewPlace, keep: boolean): void {
  const hosts = index.get(tabId) ?? new Map<ExecutionHostId, Set<string>>()
  const keys = hosts.get(place.hostId) ?? new Set<string>()
  if (keep) {
    keys.add(place.key)
  } else {
    keys.delete(place.key)
  }
  if (keys.size) {
    hosts.set(place.hostId, keys)
  } else {
    hosts.delete(place.hostId)
  }
  if (hosts.size) {
    index.set(tabId, hosts)
  } else {
    index.delete(tabId)
  }
}

function viewIndex(runtime: ViewsRuntime): ViewIndex {
  let index = viewIndexes.get(runtime.layoutEditorViews)
  if (!index) {
    index = new Map()
    for (const [hostId, partition] of runtime.layoutEditorViews) {
      for (const [key, views] of Object.entries(partition)) {
        for (const tabId of Object.keys(views)) {
          addViewPlace(index, tabId, { hostId, key }, true)
        }
      }
    }
    viewIndexes.set(runtime.layoutEditorViews, index)
  }
  return index
}

function keepViews(
  runtime: ViewsRuntime,
  hostId: ExecutionHostId,
  views: PartitionEditorViews,
  owners?: ReadonlySet<string>
): PartitionEditorViews {
  const index = viewIndex(runtime)
  const prior = runtime.layoutEditorViews.get(hostId) ?? {}
  const next = owners ? { ...prior } : { ...views }
  const keys = owners ?? new Set([...Object.keys(prior), ...Object.keys(views)])
  for (const key of keys) {
    for (const tabId of Object.keys(prior[key] ?? {})) {
      addViewPlace(index, tabId, { hostId, key }, false)
    }
    if (owners) {
      if (views[key]) {
        next[key] = views[key]
      } else {
        delete next[key]
      }
    }
    for (const tabId of Object.keys(next[key] ?? {})) {
      addViewPlace(index, tabId, { hostId, key }, true)
    }
  }
  runtime.layoutEditorViews.set(hostId, next)
  return next
}

/** Restore only view bags no later keep or refile has replaced. */
export function keepPartitionEditorViews(
  runtime: ViewsRuntime,
  hostId: ExecutionHostId,
  views: PartitionEditorViews,
  owners?: ReadonlySet<string>
): () => void {
  const before = runtime.layoutEditorViews.get(hostId) ?? {}
  const installed = keepViews(runtime, hostId, views, owners)
  return () => {
    if (!owners) {
      if (runtime.layoutEditorViews.get(hostId) === installed) {
        keepViews(runtime, hostId, before)
      }
      return
    }
    const current = runtime.layoutEditorViews.get(hostId) ?? {}
    const restorable = new Set([...owners].filter((key) => current[key] === installed[key]))
    if (restorable.size) {
      keepViews(runtime, hostId, before, restorable)
    }
  }
}

/** Move only affected editor tabs; untouched view bags retain their rollback identities. */
export function refileEditorViews(
  runtime: Pick<StoreRuntimeState, 'layoutEditorViews' | 'state'>,
  changes?: SessionChangeSet
): void {
  const changed = changes?.units.filter((unit) => unit.field === 'unifiedTabs')
  if (changes && !changes.fullReplacement && !changed?.length) {
    return
  }
  const index = viewIndex(runtime)
  const tabs = changes && !changes.fullReplacement ? changes.tabs : new Set(index.keys())
  const edited = new Map<
    ExecutionHostId,
    Record<string, Readonly<Record<string, LayoutEditorView>>>
  >()
  const bags = new Map<string, Record<string, LayoutEditorView>>()
  const editable = (place: ViewPlace): Record<string, LayoutEditorView> => {
    const id = JSON.stringify([place.hostId, place.key])
    let bag = bags.get(id)
    if (!bag) {
      let partition = edited.get(place.hostId)
      if (!partition) {
        partition = { ...runtime.layoutEditorViews.get(place.hostId) }
        edited.set(place.hostId, partition)
      }
      bag = { ...partition[place.key] }
      bags.set(id, bag)
      partition[place.key] = bag
    }
    return bag
  }
  const strays: [string, LayoutEditorView][] = []
  for (const tabId of tabs) {
    for (const [hostId, keys] of index.get(tabId) ?? []) {
      for (const key of keys) {
        if (holdsEditorTab(sessionOf(runtime, hostId), key, tabId)) {
          continue
        }
        const place = { hostId, key }
        const view = runtime.layoutEditorViews.get(hostId)?.[key]?.[tabId]
        if (view) {
          strays.push([tabId, view])
        }
        delete editable(place)[tabId]
        addViewPlace(index, tabId, place, false)
      }
    }
  }
  for (const [tabId, view] of strays) {
    const places = placesHolding(runtime, tabId)
    const place = places.length === 1 ? places[0] : undefined
    if (!place) {
      continue
    }
    const holder = edited.get(place.hostId) ?? runtime.layoutEditorViews.get(place.hostId)
    if (holder?.[place.key]?.[tabId]) {
      continue
    }
    editable(place)[tabId] = view
    addViewPlace(index, tabId, place, true)
  }
  for (const [id, bag] of bags) {
    if (Object.keys(bag).length) {
      continue
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: keys are encoded locally as a host id and workspace key above.
    const [hostId, key] = JSON.parse(id) as [ExecutionHostId, string]
    delete edited.get(hostId)?.[key]
  }
  for (const [hostId, partition] of edited) {
    if (Object.keys(partition).length) {
      runtime.layoutEditorViews.set(hostId, partition)
    } else {
      runtime.layoutEditorViews.delete(hostId)
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
  const publication = sessionPublication(runtime.state)
  return [...hostIds].flatMap((hostId) =>
    publication
      .partition(hostId)
      .index.references('tab', tabId)
      .filter(
        ({ field, key }) =>
          field === 'unifiedTabs' && holdsEditorTab(sessionOf(runtime, hostId), key, tabId)
      )
      .map(({ key }) => ({ hostId, key }))
  )
}
