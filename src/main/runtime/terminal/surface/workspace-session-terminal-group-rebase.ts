import { structuralValuesEqualIgnoringUndefined } from '../../../../shared/structural-value-equality'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { rebaseTerminalGroupLayout } from './workspace-session-terminal-group-layout-rebase'

function sameItems<T>(before: readonly T[], after: readonly T[]): boolean {
  return before.length === after.length && before.every((item, index) => item === after[index])
}

function reuseCurrent<T>(candidate: T, current: T | undefined): T {
  return current !== undefined && structuralValuesEqualIgnoringUndefined(candidate, current)
    ? current
    : candidate
}

function terminalTabMatches(tab: Tab, terminalTabIds: ReadonlySet<string>): boolean {
  return (
    tab.contentType === 'terminal' &&
    (terminalTabIds.has(tab.id) || terminalTabIds.has(tab.entityId))
  )
}

function rebaseUnifiedTabs(
  candidate: Tab[],
  current: readonly Tab[],
  terminalTabIds: ReadonlySet<string>
): Tab[] {
  const result = candidate.filter(
    (tab) => tab.contentType !== 'terminal' || terminalTabMatches(tab, terminalTabIds)
  )
  const represented = new Set(
    result.flatMap((tab) => (tab.contentType === 'terminal' ? [tab.id, tab.entityId] : []))
  )
  for (const tab of current) {
    if (
      terminalTabMatches(tab, terminalTabIds) &&
      !represented.has(tab.id) &&
      !represented.has(tab.entityId)
    ) {
      result.push(tab)
    }
  }
  return sameItems(candidate, result) ? candidate : result
}

function withTabOrder(group: TabGroup, tabOrder: string[]): TabGroup {
  const ids = new Set(tabOrder)
  const activeTabId =
    group.activeTabId && ids.has(group.activeTabId) ? group.activeTabId : (tabOrder[0] ?? null)
  const recentTabIds = group.recentTabIds?.filter((id) => ids.has(id))
  return sameItems(group.tabOrder, tabOrder) &&
    activeTabId === group.activeTabId &&
    sameItems(group.recentTabIds ?? [], recentTabIds ?? [])
    ? group
    : {
        ...group,
        tabOrder,
        activeTabId,
        ...(group.recentTabIds ? { recentTabIds } : {})
      }
}

function restoreMissingOrder(
  candidate: readonly string[],
  current: readonly string[],
  missing: ReadonlySet<string>
): string[] {
  const placed = new Set(candidate)
  const before = new Map<string, string[]>()
  let pending: string[] = []
  for (const id of current) {
    if (missing.has(id)) {
      pending.push(id)
    } else if (placed.has(id) && pending.length > 0) {
      before.set(id, pending)
      pending = []
    }
  }
  return [...candidate.flatMap((id) => [...(before.get(id) ?? []), id]), ...pending]
}

export function rebaseTerminalGroupPresentation(
  incoming: WorkspaceSessionState,
  prior: WorkspaceSessionState,
  worktreeId: string,
  terminalTabIds: ReadonlySet<string>
) {
  const candidateTabs = incoming.unifiedTabs?.[worktreeId] ?? []
  let unifiedTabs = rebaseUnifiedTabs(
    candidateTabs,
    prior.unifiedTabs?.[worktreeId] ?? [],
    terminalTabIds
  )
  const validIds = new Set([...terminalTabIds, ...unifiedTabs.map((tab) => tab.id)])
  const terminalIds = new Set([
    ...terminalTabIds,
    ...unifiedTabs.filter((tab) => terminalTabMatches(tab, terminalTabIds)).map((tab) => tab.id)
  ])
  const currentGroups = prior.tabGroups?.[worktreeId] ?? []
  const candidateGroups = incoming.tabGroups?.[worktreeId] ?? currentGroups
  let groups = candidateGroups.flatMap((group) => {
    const order = group.tabOrder.filter((id) => validIds.has(id))
    return order.length > 0 || group.tabOrder.length === 0 ? [withTabOrder(group, order)] : []
  })
  const represented = new Set(groups.flatMap((group) => group.tabOrder))
  const groupIndex = new Map(groups.map((group, index) => [group.id, index]))
  for (const current of currentGroups) {
    const missing = new Set(
      current.tabOrder.filter((id) => terminalIds.has(id) && !represented.has(id))
    )
    if (missing.size === 0) {
      continue
    }
    const at = groupIndex.get(current.id)
    if (at === undefined) {
      groupIndex.set(current.id, groups.length)
      groups.push(
        withTabOrder(
          current,
          current.tabOrder.filter((id) => missing.has(id))
        )
      )
    } else {
      const group = groups[at]!
      groups[at] = withTabOrder(
        group,
        restoreMissingOrder(group.tabOrder, current.tabOrder, missing)
      )
    }
    for (const id of missing) {
      represented.add(id)
    }
  }
  if (sameItems(candidateGroups, groups)) {
    groups = candidateGroups
  }
  const groupByTabId = new Map(
    groups.flatMap((group) => group.tabOrder.map((id): [string, string] => [id, group.id]))
  )
  const placedTabs = unifiedTabs.map((tab) => {
    const groupId = groupByTabId.get(tab.id)
    return tab.contentType === 'terminal' && groupId && groupId !== tab.groupId
      ? { ...tab, groupId }
      : tab
  })
  if (!sameItems(unifiedTabs, placedTabs)) {
    unifiedTabs = placedTabs
  }
  const priorGroupIds = new Set(currentGroups.map((group) => group.id))
  const requiredGroupIds = new Set(
    groups
      .filter(
        (group) => priorGroupIds.has(group.id) && group.tabOrder.some((id) => terminalIds.has(id))
      )
      .map((group) => group.id)
  )
  const layout = rebaseTerminalGroupLayout(
    incoming.tabGroupLayouts?.[worktreeId] ?? prior.tabGroupLayouts?.[worktreeId],
    prior.tabGroupLayouts?.[worktreeId],
    new Set(groups.map((group) => group.id)),
    requiredGroupIds
  )
  return {
    unifiedTabs: reuseCurrent(unifiedTabs, prior.unifiedTabs?.[worktreeId]),
    groups: reuseCurrent(groups, prior.tabGroups?.[worktreeId]),
    layout: reuseCurrent(layout, prior.tabGroupLayouts?.[worktreeId]),
    validIds
  }
}
