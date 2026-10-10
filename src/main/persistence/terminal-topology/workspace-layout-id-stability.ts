import {
  collectTerminalLeafOwners,
  isSameTerminal,
  type TerminalLeafOwner
} from './terminal-owner-invariants'
import type {
  WorkspaceLayoutPartition,
  WorkspaceLayoutViolation
} from './workspace-layout-rule-types'

// An update must keep the id of every pane, tab and group it did not create or remove; a new id
// for the same entity remounts its view.

type EntityIndex = {
  leafByTerminal: TerminalLeafOwner[]
  leavesByTab: Map<string, Set<string>>
  tabsByGroup: Map<string, Set<string>>
}

function indexEntities(partition: WorkspaceLayoutPartition): EntityIndex {
  const leafByTerminal = collectTerminalLeafOwners(partition)
  const leavesByTab = new Map<string, Set<string>>()
  for (const owner of leafByTerminal) {
    leavesByTab.set(owner.tab.id, (leavesByTab.get(owner.tab.id) ?? new Set()).add(owner.leafId))
  }
  const tabsByGroup = new Map<string, Set<string>>()
  for (const groups of Object.values(partition.session.tabGroups ?? {})) {
    for (const group of groups) {
      tabsByGroup.set(group.id, new Set(group.tabOrder))
    }
  }
  return { leafByTerminal, leavesByTab, tabsByGroup }
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id))
}

/** Entities that vanished and reappeared whole under a new id: a remount, not an edit. */
function replacedIds(
  before: Map<string, Set<string>>,
  after: Map<string, Set<string>>
): [string, string][] {
  const replaced: [string, string][] = []
  for (const [oldId, members] of before) {
    if (after.has(oldId) || members.size === 0) {
      continue
    }
    for (const [newId, newMembers] of after) {
      if (!before.has(newId) && sameSet(members, newMembers)) {
        replaced.push([oldId, newId])
      }
    }
  }
  return replaced
}

export function checkWorkspaceLayoutIdStability(
  previous: WorkspaceLayoutPartition,
  next: WorkspaceLayoutPartition
): WorkspaceLayoutViolation[] {
  const { hostId } = next
  const before = indexEntities(previous)
  const after = indexEntities(next)
  const violations: WorkspaceLayoutViolation[] = []
  for (const owner of after.leafByTerminal) {
    // A drag-out keeps the pane id and changes its tab; only a new pane id is a remount.
    const earlier = before.leafByTerminal.find(
      (candidate) => candidate.ptyId !== undefined && isSameTerminal(candidate, owner)
    )
    if (earlier && earlier.leafId !== owner.leafId) {
      violations.push({
        rule: 'pane_id_changed',
        hostId,
        worktreeId: owner.worktreeId,
        ids: [owner.ptyId!, earlier.leafId, owner.leafId],
        detail: `terminal ${owner.ptyId} moved from pane ${earlier.leafId} to new pane ${owner.leafId}`
      })
    }
  }
  for (const [oldId, newId] of replacedIds(before.leavesByTab, after.leavesByTab)) {
    violations.push({
      rule: 'tab_id_changed',
      hostId,
      ids: [oldId, newId],
      detail: `tab ${oldId} was replaced by ${newId} holding the same panes`
    })
  }
  for (const [oldId, newId] of replacedIds(before.tabsByGroup, after.tabsByGroup)) {
    violations.push({
      rule: 'group_id_changed',
      hostId,
      ids: [oldId, newId],
      detail: `group ${oldId} was replaced by ${newId} holding the same tabs`
    })
  }
  return violations
}
