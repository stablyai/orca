import { GIT_GRAPH_TAB_CAPABILITY } from '../../../shared/source-control/runtime/git-graph-capabilities'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import {
  applyPublishedLayoutRecordChanges,
  splitPublishedLayout,
  joinPublishedLayout,
  type PublishedLayoutRecords,
  diffPublishedLayouts,
  indexPublishedLayout
} from '../../../shared/workspace-layout/workspace-layout-records'
import type { WorkspaceLayoutStreamFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import type { WindowLayoutCommand } from '../terminal/layout/runtime-layout-apply'
import {
  changedSplitRatios,
  splitRatioIntentAt,
  withGroupSplitRatios
} from '../../../shared/workspace-layout/split-ratio-intents'

export const GIT_GRAPH_PLACEMENT_COMMANDS = new Set<WindowLayoutCommand['type']>([
  'moveTab',
  'setGroupRatios',
  'createTerminalTab',
  'openEditorTab',
  'openSimulatorTab',
  'openBrowserTab',
  'openAgentSessionTab',
  'movePaneToNewTab',
  'moveTabToWorkspace'
])

export function readsGitGraph(capabilities?: readonly string[]): boolean {
  return capabilities?.includes(GIT_GRAPH_TAB_CAPABILITY) === true
}

function projectedTree(
  node: TabGroupLayoutNode | undefined,
  groups: Set<string>,
  paths?: Map<string, string>,
  fullPath = '',
  path = ''
): TabGroupLayoutNode | undefined {
  if (!node) {
    return undefined
  }
  if (node.type === 'leaf') {
    return groups.has(node.groupId) ? node : undefined
  }
  const join = (base: string, side: string) => (base ? `${base}.${side}` : side)
  const has = (child: TabGroupLayoutNode): boolean =>
    child.type === 'leaf' ? groups.has(child.groupId) : has(child.first) || has(child.second)
  const firstVisible = has(node.first)
  const secondVisible = has(node.second)
  if (!firstVisible) {
    return projectedTree(node.second, groups, paths, join(fullPath, 'second'), path)
  }
  if (!secondVisible) {
    return projectedTree(node.first, groups, paths, join(fullPath, 'first'), path)
  }
  paths?.set(path, fullPath)
  return {
    ...node,
    first: projectedTree(node.first, groups, paths, join(fullPath, 'first'), join(path, 'first'))!,
    second: projectedTree(
      node.second,
      groups,
      paths,
      join(fullPath, 'second'),
      join(path, 'second')
    )!
  }
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
    groupLayout: projectedTree(layout.groupLayout, new Set(groups.map((group) => group.id)))
  }
}

// Re-diff whole projected layouts: a delta alone may omit the group a hidden tab made empty.
export function createGitGraphFrameProjection() {
  const layouts = new Map<string, PublishedLayoutRecords>()
  return (frame: WorkspaceLayoutStreamFrame): WorkspaceLayoutStreamFrame => {
    switch (frame.type) {
      case 'end':
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
            if (
              ![before, after].some((records) =>
                records?.tabs.some((tab) => tab.kind === 'git-graph')
              )
            ) {
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

export function translateGitGraphLayoutCommand(
  command: WindowLayoutCommand,
  layout: PublishedWorkspaceLayout
): WindowLayoutCommand {
  const projected = projectGitGraphLayout(layout)
  if (projected === layout) {
    return command
  }
  if (
    command.type === 'createTerminalTab' ||
    command.type === 'openEditorTab' ||
    command.type === 'openSimulatorTab' ||
    command.type === 'openBrowserTab' ||
    command.type === 'openAgentSessionTab' ||
    command.type === 'movePaneToNewTab' ||
    command.type === 'moveTabToWorkspace'
  ) {
    const canonicalGroupId = projected.groups[0]?.id ?? layout.groups[0]?.id
    if (canonicalGroupId && 'split' in command && command.split) {
      const canonicalAnchor = (id: string) =>
        layout.groups.some((group) => group.id === id) ? id : canonicalGroupId
      return {
        ...command,
        split: {
          ...command.split,
          besideGroupId: canonicalAnchor(command.split.besideGroupId),
          ...(command.split.besideLastGroupId
            ? { besideLastGroupId: canonicalAnchor(command.split.besideLastGroupId) }
            : {})
        }
      }
    }
    const groupId = 'groupId' in command ? command.groupId : undefined
    if (canonicalGroupId && !projected.groups.some((group) => group.id === groupId)) {
      return { ...command, groupId: canonicalGroupId }
    }
  }

  if (command.type === 'moveTab') {
    const fullOrder =
      layout.groups
        .find((group) => group.id === command.toGroupId)
        ?.tabIds.filter((id) => id !== command.tabId) ?? []
    const visible = new Set(projected.tabs.map((tab) => tab.id))
    const visibleOrder = fullOrder.filter((id) => visible.has(id))
    const after = command.afterTabId ? visibleOrder.indexOf(command.afterTabId) : -1
    const at = command.afterTabId === null ? 0 : after !== -1 ? after + 1 : command.index
    const next = visibleOrder[at]
    return {
      ...command,
      afterTabId: undefined,
      index: next ? fullOrder.indexOf(next) : fullOrder.length
    }
  }
  if (command.type === 'setGroupRatios') {
    const paths = new Map<string, string>()
    projectedTree(layout.groupLayout, new Set(projected.groups.map((group) => group.id)), paths)
    const ratios =
      command.ratios ??
      (projected.groupLayout && command.groupLayout
        ? changedSplitRatios(projected.groupLayout, command.groupLayout)
        : [])
    if (!projected.groupLayout || !withGroupSplitRatios(projected.groupLayout, ratios)) {
      throw new Error('Layout split changed; refresh and try again')
    }
    return {
      ...command,
      groupLayout: undefined,
      ratios: ratios.map(({ path, ratio }) => {
        const translated = paths.get(path)
        if (translated === undefined) {
          throw new Error('Layout split changed; refresh and try again')
        }
        return splitRatioIntentAt(layout.groupLayout!, translated, ratio)!
      })
    }
  }
  return command
}
