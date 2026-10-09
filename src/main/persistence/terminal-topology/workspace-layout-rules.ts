// Structural rules for the workspace tab layout the runtime holds. Pure: callers pass the runtime's
// session partitions (and optionally the previous ones) and get every breach back.

import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'
import {
  collectTerminalLeafOwners,
  isSameTerminal,
  isTerminalOwnerPartition,
  type TerminalLeafOwner
} from './terminal-owner-invariants'
import { checkWorkspaceLayoutIdStability } from './workspace-layout-id-stability'
import type {
  WorkspaceLayoutPartition,
  WorkspaceLayoutViolation
} from './workspace-layout-rule-types'

export type * from './workspace-layout-rule-types'

function describeOwner(owner: TerminalLeafOwner): string {
  return `${owner.hostId} ${owner.worktreeId} ${owner.tab.id}:${owner.leafId} → ${owner.ptyId ?? 'unbound'}`
}

/** Owner partitions share PTY ids (relay rows left in `local`); a `runtime:` mirror is checked alone. */
function ownerGroups(partitions: readonly WorkspaceLayoutPartition[]): TerminalLeafOwner[][] {
  const shared = partitions.filter((partition) => isTerminalOwnerPartition(partition.hostId))
  const mirrors = partitions.filter((partition) => !isTerminalOwnerPartition(partition.hostId))
  return [
    shared.flatMap((partition) => collectTerminalLeafOwners(partition)),
    ...mirrors.map((partition) => collectTerminalLeafOwners(partition))
  ]
}

function checkPanes(partitions: readonly WorkspaceLayoutPartition[]): WorkspaceLayoutViolation[] {
  const violations: WorkspaceLayoutViolation[] = []
  for (const owners of ownerGroups(partitions)) {
    for (const [index, left] of owners.entries()) {
      for (const right of owners.slice(index + 1)) {
        const base = { hostId: left.hostId, worktreeId: left.worktreeId }
        if (left.leafId === right.leafId) {
          const sameTab = left.tab.id === right.tab.id && left.hostId === right.hostId
          violations.push({
            ...base,
            rule: sameTab ? 'pane_twice_in_one_tab' : 'pane_in_two_tabs',
            ids: [left.leafId, left.tab.id, right.tab.id],
            detail: `${describeOwner(left)} | ${describeOwner(right)}`
          })
        } else if (isSameTerminal(left, right)) {
          violations.push({
            ...base,
            rule: 'terminal_in_two_panes',
            ids: [left.ptyId!, left.leafId, right.leafId],
            detail: `${describeOwner(left)} | ${describeOwner(right)}`
          })
        }
      }
    }
  }
  return violations
}

function checkTabRows({ hostId, session }: WorkspaceLayoutPartition): WorkspaceLayoutViolation[] {
  const violations: WorkspaceLayoutViolation[] = []
  const tabRows = new Map<string, string[]>()
  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      tabRows.set(tab.id, [...(tabRows.get(tab.id) ?? []), worktreeId])
    }
  }
  for (const [tabId, worktreeIds] of tabRows) {
    if (worktreeIds.length > 1) {
      violations.push({
        rule: 'tab_in_two_places',
        hostId,
        worktreeId: worktreeIds[0],
        ids: [tabId],
        detail: `tab row listed ${worktreeIds.length} times: ${worktreeIds.join(', ')}`
      })
    }
  }
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const leafIds = collectLayoutLeafIdsInOrder(layout.root)
    if (!tabRows.has(tabId) && leafIds.length > 0) {
      violations.push({
        rule: 'pane_without_tab',
        hostId,
        ids: [tabId, ...leafIds],
        detail: `layout for tab ${tabId} has panes but no tab row`
      })
    }
    const strayBindings = Object.keys(layout.ptyIdsByLeafId ?? {}).filter(
      (leafId) => !leafIds.includes(leafId)
    )
    if (strayBindings.length > 0) {
      violations.push({
        rule: 'binding_without_pane',
        hostId,
        ids: [tabId, ...strayBindings],
        detail: `tab ${tabId} binds terminals to panes its layout lacks`
      })
    }
  }
  return violations
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function checkGroups(
  hostId: ExecutionHostId,
  worktreeId: string,
  terminalTabIds: readonly string[],
  tabs: readonly Tab[] | undefined,
  groups: readonly TabGroup[] | undefined
): WorkspaceLayoutViolation[] {
  const violations: WorkspaceLayoutViolation[] = []
  const at = { hostId, worktreeId }
  const unified = tabs ?? []
  const unifiedById = new Map(unified.map((tab) => [tab.id, tab]))
  const groupsByTab = new Map<string, string[]>()
  for (const group of groups ?? []) {
    for (const tabId of group.tabOrder) {
      groupsByTab.set(tabId, [...(groupsByTab.get(tabId) ?? []), group.id])
      if (!unifiedById.has(tabId)) {
        violations.push({
          ...at,
          rule: 'group_lists_missing_tab',
          ids: [group.id, tabId],
          detail: `group ${group.id} lists tab ${tabId}, which does not exist`
        })
      }
    }
  }
  for (const tab of unified) {
    const owners = groupsByTab.get(tab.id) ?? []
    if (owners.length === 0) {
      violations.push({
        ...at,
        rule: 'tab_without_group',
        ids: [tab.id],
        detail: `tab ${tab.id} (${tab.contentType}) is in no group's tab order`
      })
    } else if (owners.length > 1) {
      violations.push({
        ...at,
        rule: 'tab_in_two_groups',
        ids: [tab.id, ...owners],
        detail: `tab ${tab.id} is listed by ${owners.length} group entries: ${owners.join(', ')}`
      })
    } else if (owners[0] !== tab.groupId) {
      violations.push({
        ...at,
        rule: 'tab_group_mismatch',
        ids: [tab.id, tab.groupId, owners[0]!],
        detail: `tab ${tab.id} says group ${tab.groupId} but group ${owners[0]} lists it`
      })
    }
  }

  // A terminal tab row is the same tab as the unified entry whose entity it is.
  const unifiedTerminalIds = unified
    .filter((tab) => tab.contentType === 'terminal')
    .map((tab) => tab.entityId)
  const rowSet = new Set(terminalTabIds)
  const unifiedSet = new Set(unifiedTerminalIds)
  const onlyRows = terminalTabIds.filter((id) => !unifiedSet.has(id))
  const onlyUnified = unifiedTerminalIds.filter((id) => !rowSet.has(id))
  if (onlyRows.length > 0 || onlyUnified.length > 0) {
    violations.push({
      ...at,
      rule: 'tab_lists_disagree',
      ids: [...onlyRows, ...onlyUnified],
      detail:
        `terminal tab rows and tab bar disagree; rows only: [${onlyRows.join(', ')}], ` +
        `tab bar only: [${onlyUnified.join(', ')}]`
    })
  }

  // One order: within each group, its terminal tabs appear in the rows in the same order.
  const entityByTabId = new Map(unified.map((tab) => [tab.id, tab.entityId]))
  for (const group of groups ?? []) {
    const groupTerminals = group.tabOrder
      .filter((tabId) => unifiedById.get(tabId)?.contentType === 'terminal')
      .map((tabId) => entityByTabId.get(tabId)!)
    const members = new Set(groupTerminals)
    const rowOrder = terminalTabIds.filter((id) => members.has(id))
    if (
      !sameOrder(
        rowOrder,
        groupTerminals.filter((id) => rowSet.has(id))
      )
    ) {
      violations.push({
        ...at,
        rule: 'tab_order_disagrees',
        ids: [group.id],
        detail:
          `group ${group.id} orders terminals [${groupTerminals.join(', ')}] ` +
          `but the tab rows order them [${rowOrder.join(', ')}]`
      })
    }
  }
  return violations
}

function checkTabBar({ hostId, session }: WorkspaceLayoutPartition): WorkspaceLayoutViolation[] {
  const worktreeIds = new Set([
    ...Object.keys(session.tabsByWorktree ?? {}),
    ...Object.keys(session.unifiedTabs ?? {}),
    ...Object.keys(session.tabGroups ?? {})
  ])
  return [...worktreeIds].flatMap((worktreeId) => {
    const rows = session.tabsByWorktree?.[worktreeId] ?? []
    // A headless runtime saves only the rows today; one finding per worktree, not one per tab.
    if (!session.unifiedTabs?.[worktreeId] && !session.tabGroups?.[worktreeId] && rows.length) {
      const violation: WorkspaceLayoutViolation = {
        rule: 'tab_bar_missing',
        hostId,
        worktreeId,
        ids: rows.map((tab) => tab.id),
        detail: `${rows.length} terminal tab rows but no tab bar or groups`
      }
      return [violation]
    }
    return checkGroups(
      hostId,
      worktreeId,
      (session.tabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id),
      session.unifiedTabs?.[worktreeId],
      session.tabGroups?.[worktreeId]
    )
  })
}

/**
 * Every structural breach in the runtime's layout. With `previous`, also flags ids that changed
 * for the same pane, tab or group across the update.
 */
export function checkWorkspaceLayoutRules(
  partitions: readonly WorkspaceLayoutPartition[],
  previous?: readonly WorkspaceLayoutPartition[]
): WorkspaceLayoutViolation[] {
  const violations = [
    ...checkPanes(partitions),
    ...partitions.flatMap(checkTabRows),
    ...partitions.flatMap(checkTabBar)
  ]
  for (const partition of partitions) {
    const earlier = previous?.find((candidate) => candidate.hostId === partition.hostId)
    if (earlier) {
      violations.push(...checkWorkspaceLayoutIdStability(earlier, partition))
    }
  }
  return violations
}
