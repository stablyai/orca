import type { PublishedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-published'
import {
  diffPublishedLayouts,
  indexPublishedLayout,
  type IndexedLayoutRecords,
  type WorkspaceLayoutRecordChange
} from '../../shared/workspace-layout/workspace-layout-records'
export type Shown = {
  json: string
  liveTitles: string
  layout: PublishedWorkspaceLayout
  /** Null sends a whole layout; otherwise index records lazily on the next diff. */
  records?: IndexedLayoutRecords | null
}
export function reconcileShownLayouts(
  next: ReadonlyMap<string, { layout: PublishedWorkspaceLayout; json: string }>,
  prior: Map<string, Shown>,
  keys: Iterable<string>,
  full: boolean,
  decorate: (layout: PublishedWorkspaceLayout) => Pick<Shown, 'liveTitles' | 'layout'>
) {
  const removed: string[] = []
  const before = new Map<string, Shown>()
  const shown = full ? new Map<string, Shown>() : prior
  const changed: string[] = []
  for (const key of keys) {
    const previous = prior.get(key)
    if (previous) {
      before.set(key, previous)
    }
    const projected = next.get(key)
    if (!projected) {
      shown.delete(key)
      if (previous) {
        removed.push(key)
      }
      continue
    }
    const { layout, json } = projected
    const decorated = decorate(layout)
    if (previous?.json === json && previous.liveTitles === decorated.liveTitles) {
      shown.set(key, previous)
      continue
    }
    shown.set(key, { json, ...decorated })
    changed.push(key)
  }

  return { removed, before, shown, changed }
}
export function changedLayoutRecords(
  before: ReadonlyMap<string, Shown>,
  shown: ReadonlyMap<string, Shown>,
  removed: readonly string[],
  changed: readonly string[]
): WorkspaceLayoutRecordChange[] {
  const workspaces: WorkspaceLayoutRecordChange[] = removed.map((key) => ({
    key,
    change: 'removed'
  }))
  for (const key of changed) {
    const previous = before.get(key)
    const current = shown.get(key)!
    const change = previous
      ? diffPublishedLayouts(key, recordsOf(previous), recordsOf(current), current.layout)
      : { key, change: 'layout' as const, layout: current.layout }
    if (change) {
      workspaces.push(change)
    }
  }

  return workspaces
}
function recordsOf(shown: Shown): IndexedLayoutRecords | null {
  if (shown.records === undefined) {
    shown.records = indexPublishedLayout(shown.layout)
  }
  return shown.records
}
