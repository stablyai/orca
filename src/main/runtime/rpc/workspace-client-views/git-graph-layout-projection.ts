import { GIT_GRAPH_TAB_CAPABILITY } from '../../../../shared/source-control/runtime/git-graph-capabilities'
import { visibleGroupTree } from '../../../../shared/workspace-layout/client-views/workspace-layout-client-visibility'
import type { PublishedWorkspaceLayout } from '../../../../shared/workspace-layout/published-layout/workspace-layout-published'
import {
  applyPublishedLayoutRecordChanges,
  splitPublishedLayout,
  joinPublishedLayout,
  type PublishedLayoutRecords,
  diffPublishedLayouts,
  indexPublishedLayout
} from '../../../../shared/workspace-layout/published-layout/workspace-layout-records'
import type { WorkspaceLayoutStreamFrame } from '../../../../shared/workspace-layout/published-layout/workspace-layout-stream-frames'
export function readsGitGraph(capabilities?: readonly string[]): boolean {
  return capabilities?.includes(GIT_GRAPH_TAB_CAPABILITY) === true
}

export function projectGitGraphLayout(layout: PublishedWorkspaceLayout): PublishedWorkspaceLayout {
  const hidden = new Set(layout.tabs.filter((tab) => tab.kind === 'git-graph').map((tab) => tab.id))
  if (!hidden.size) {
    return layout
  }
  const hiddenFiles = new Set(
    layout.tabs.filter((tab) => hidden.has(tab.id)).map((tab) => tab.entityId)
  )
  const groups = layout.groups
    .filter((group) => !group.tabIds.length || group.tabIds.some((id) => !hidden.has(id)))
    .map((group) => ({ ...group, tabIds: group.tabIds.filter((id) => !hidden.has(id)) }))
  return {
    ...layout,
    tabs: layout.tabs.filter((tab) => !hidden.has(tab.id)),
    editorFiles: layout.editorFiles.filter((file) => !hiddenFiles.has(file.filePath)),
    groups,
    groupLayout: visibleGroupTree(layout.groupLayout, new Set(groups.map((group) => group.id)))
  }
}

// Re-diff whole projected layouts: a delta alone may omit the group a hidden tab made empty.
export function createGitGraphFrameProjection() {
  const presence = new WeakMap<PublishedLayoutRecords['tabs'], boolean>()
  const hasGraph = (records: PublishedLayoutRecords | undefined): boolean => {
    if (!records) {
      return false
    }
    const cached = presence.get(records.tabs)
    if (cached !== undefined) {
      return cached
    }
    const found = records.tabs.some((tab) => tab.kind === 'git-graph')
    presence.set(records.tabs, found)
    return found
  }
  const layouts = new Map<string, PublishedLayoutRecords>()
  return (frame: WorkspaceLayoutStreamFrame): WorkspaceLayoutStreamFrame => {
    switch (frame.type) {
      case 'end':
        layouts.clear()
        return frame
      case 'removed':
        layouts.delete(frame.key)
        return frame
      case 'snapshot':
        layouts.clear()
        return {
          ...frame,
          workspaces: frame.workspaces.map(({ key, layout }) => {
            layouts.set(key, splitPublishedLayout(layout))
            return { key, layout: projectGitGraphLayout(layout) }
          })
        }
      case 'workspace':
        layouts.set(frame.key, splitPublishedLayout(frame.layout))
        return { ...frame, layout: projectGitGraphLayout(frame.layout) }
      case 'records':
        return {
          ...frame,
          workspaces: frame.workspaces.flatMap((change) => {
            const before = layouts.get(change.key)
            if (change.change === 'removed') {
              layouts.delete(change.key)
              return [change]
            }
            const after =
              change.change === 'layout'
                ? splitPublishedLayout(change.layout)
                : applyPublishedLayoutRecordChanges(before!, change)
            layouts.set(change.key, after)
            if (!hasGraph(before) && !hasGraph(after)) {
              return [change]
            }
            const projected = projectGitGraphLayout(joinPublishedLayout(after))
            const diff = diffPublishedLayouts(
              change.key,
              before
                ? indexPublishedLayout(projectGitGraphLayout(joinPublishedLayout(before)))
                : null,
              indexPublishedLayout(projected),
              projected
            )
            return diff ? [diff] : []
          })
        }
    }
  }
}
