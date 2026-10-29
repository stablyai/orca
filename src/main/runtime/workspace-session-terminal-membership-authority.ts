import { SessionUnitIndex } from '../../shared/session-unit-index'
import { SessionUnitReader } from '../../shared/session-unit-reader'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { Tab, TabGroup } from '../../shared/tab-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { pruneTabGroupLayoutAfterRetirement } from './mobile-session-terminal-retirement'

function collectLeafIds(node: TerminalPaneLayoutNode | null, ids: Set<string>): void {
  if (!node) {
    return
  }
  if (node.type === 'leaf') {
    ids.add(node.leafId)
    return
  }
  collectLeafIds(node.first, ids)
  collectLeafIds(node.second, ids)
}

function layoutHasSameMembership(
  candidate: TerminalLayoutSnapshot,
  current: TerminalLayoutSnapshot
): boolean {
  const candidateIds = new Set<string>()
  const currentIds = new Set<string>()
  collectLeafIds(candidate.root, candidateIds)
  collectLeafIds(current.root, currentIds)
  return (
    candidateIds.size === currentIds.size &&
    [...candidateIds].every((leafId) => currentIds.has(leafId))
  )
}

function rebaseLayout(
  candidate: TerminalLayoutSnapshot | undefined,
  current: TerminalLayoutSnapshot | undefined
): TerminalLayoutSnapshot | undefined {
  if (!current) {
    return undefined
  }
  if (!candidate || !layoutHasSameMembership(candidate, current)) {
    return current
  }
  if (
    Object.entries(current.ptyIdsByLeafId ?? {}).every(
      ([leafId, ptyId]) => candidate.ptyIdsByLeafId?.[leafId] === ptyId
    )
  ) {
    return candidate
  }
  return {
    ...candidate,
    // Renderer metadata may move; PTY bindings remain host-authoritative.
    ptyIdsByLeafId: {
      ...candidate.ptyIdsByLeafId,
      ...current.ptyIdsByLeafId
    }
  }
}

function terminalUnifiedTabMatches(tab: Tab, terminalTabIds: ReadonlySet<string>): boolean {
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
    (tab) => tab.contentType !== 'terminal' || terminalUnifiedTabMatches(tab, terminalTabIds)
  )
  const representedTerminalIds = new Set(
    result.flatMap((tab) => (tab.contentType === 'terminal' ? [tab.id, tab.entityId] : []))
  )
  for (const tab of current) {
    if (
      terminalUnifiedTabMatches(tab, terminalTabIds) &&
      !representedTerminalIds.has(tab.id) &&
      !representedTerminalIds.has(tab.entityId)
    ) {
      result.push(tab)
    }
  }
  return result.length === candidate.length &&
    result.every((tab, index) => tab === candidate[index])
    ? candidate
    : result
}

function rebaseTabGroups(groups: TabGroup[], validTabIds: ReadonlySet<string>): TabGroup[] {
  const result = groups.flatMap((group) => {
    const tabOrder = group.tabOrder.filter((tabId) => validTabIds.has(tabId))
    if (tabOrder.length === 0) {
      return []
    }
    const tabIds = new Set(tabOrder)
    const activeTabId =
      group.activeTabId && tabIds.has(group.activeTabId) ? group.activeTabId : (tabOrder[0] ?? null)
    const recentTabIds = group.recentTabIds?.filter((tabId) => tabIds.has(tabId))
    if (
      tabOrder.length === group.tabOrder.length &&
      activeTabId === group.activeTabId &&
      (!group.recentTabIds || recentTabIds?.length === group.recentTabIds.length)
    ) {
      return [group]
    }
    return [
      {
        ...group,
        tabOrder,
        activeTabId,
        // Keep empty explicitly or the group spread restores stale tab ids.
        ...(group.recentTabIds ? { recentTabIds: recentTabIds ?? [] } : {})
      }
    ]
  })
  return result.length === groups.length && result.every((group, index) => group === groups[index])
    ? groups
    : result
}

/** Full ingress enumerates the domain; incremental admissions call the same owner kernel. */
export function rebaseWorkspaceSessionTerminalMembership(
  incoming: WorkspaceSessionState,
  prior: WorkspaceSessionState | undefined
): WorkspaceSessionState {
  if (!prior?.terminalTopologyRevisionByRepoId) {
    return incoming
  }
  const reader = SessionUnitReader.between(prior, incoming, new SessionUnitIndex(prior))
  const owners = new Set([
    ...Object.keys(prior.tabsByWorktree),
    ...Object.keys(incoming.tabsByWorktree)
  ])
  const rebased = reduceSessionTerminalMembership(
    reader,
    owners,
    Object.keys(prior.terminalTopologyRevisionByRepoId)
  )
  if (rebased) {
    reduceSessionIncarnationMembership(
      reader,
      new Set([
        ...Object.keys(prior.terminalPtyIncarnationsByPaneKey ?? {}),
        ...Object.keys(incoming.terminalPtyIncarnationsByPaneKey ?? {})
      ])
    )
  }
  return reader.snapshot()
}

export function reduceSessionTerminalMembership(
  reader: SessionUnitReader,
  owners: Iterable<string>,
  repos: Iterable<string>,
  fencedRevisions?: ReadonlyMap<string, number>
): boolean {
  if (reader.policy('terminalTopologyRevisionByRepoId', 'prior')) {
    reader.reconcileField('terminalTopologyRevisionByRepoId', {
      kind: 'output',
      present: true,
      explicitEmpty: true
    })
  }
  const ownerList = [...owners]
  const repoList = [...repos]
  const supplied = new Map(
    [...new Set([...repoList, ...ownerList.map(getRepoIdFromWorktreeId)])].map((repo) => [
      repo,
      reader.unit('terminalTopologyRevisionByRepoId', repo).value ?? 0
    ])
  )
  for (const repo of repoList) {
    const before = reader.unit('terminalTopologyRevisionByRepoId', repo, 'prior')
    if (!before.present) {
      continue
    }
    reader.write('terminalTopologyRevisionByRepoId', repo, {
      present: true,
      value: Math.max(
        before.value,
        reader.unit('terminalTopologyRevisionByRepoId', repo).value ?? 0
      )
    })
  }
  let rebased = false
  for (const owner of ownerList) {
    const repo = getRepoIdFromWorktreeId(owner)
    const priorRevision = fencedRevisions
      ? (fencedRevisions.get(repo) ?? 0)
      : (reader.unit('terminalTopologyRevisionByRepoId', repo, 'prior').value ?? 0)
    // Compare the supplied revision, before max-union, to the captured host authority.
    const suppliedRevision = supplied.get(repo) ?? 0
    if (priorRevision <= 0 || suppliedRevision > priorRevision) {
      continue
    }
    rebased = true
    const candidateRows = reader.unit('tabsByWorktree', owner).value
    const currentTabs = reader.unit('tabsByWorktree', owner, 'prior').value ?? []
    const candidates = new Map((candidateRows ?? []).map((tab) => [tab.id, tab]))
    const ids = new Set(currentTabs.map((tab) => tab.id))
    const rows = currentTabs.map((current) => {
      const candidate = candidates.get(current.id)
      return candidate
        ? candidate.ptyId === current.ptyId
          ? candidate
          : { ...candidate, ptyId: current.ptyId }
        : current
    })
    for (const candidate of candidateRows ?? []) {
      if (!ids.has(candidate.id)) {
        reader.write('terminalLayoutsByTabId', candidate.id, { present: false, value: undefined })
      }
    }
    for (const tabId of ids) {
      const layout = rebaseLayout(
        reader.unit('terminalLayoutsByTabId', tabId).value,
        reader.unit('terminalLayoutsByTabId', tabId, 'prior').value
      )
      reader.write(
        'terminalLayoutsByTabId',
        tabId,
        layout ? { present: true, value: layout } : { present: false, value: undefined }
      )
    }
    const entries = rebaseUnifiedTabs(
      reader.unit('unifiedTabs', owner).value ?? [],
      reader.unit('unifiedTabs', owner, 'prior').value ?? [],
      ids
    )
    if (reader.hasField('unifiedTabs') || entries.length) {
      reader.write('unifiedTabs', owner, { present: true, value: entries })
    }
    const validIds = new Set([...ids, ...entries.map((tab) => tab.id)])
    const groups = rebaseTabGroups(
      reader.unit('tabGroups', owner).value ?? reader.unit('tabGroups', owner, 'prior').value ?? [],
      validIds
    )
    if (reader.hasField('tabGroups') || groups.length) {
      reader.write('tabGroups', owner, { present: true, value: groups })
    }
    const groupLayout = pruneTabGroupLayoutAfterRetirement(
      reader.unit('tabGroupLayouts', owner).value ??
        reader.unit('tabGroupLayouts', owner, 'prior').value,
      new Set(groups.map((group) => group.id))
    )
    reader.write(
      'tabGroupLayouts',
      owner,
      groupLayout ? { present: true, value: groupLayout } : { present: false, value: undefined }
    )
    if (!validIds.has(reader.unit('activeTabIdByWorktree', owner).value ?? '')) {
      const priorActive = reader.unit('activeTabIdByWorktree', owner, 'prior').value
      reader.write('activeTabIdByWorktree', owner, {
        present: true,
        value:
          (priorActive && validIds.has(priorActive)
            ? priorActive
            : (groups[0]?.activeTabId ?? rows[0]?.id)) ?? null
      })
    }
    reader.write('tabsByWorktree', owner, {
      present: true,
      value:
        candidateRows &&
        candidateRows.length === rows.length &&
        rows.every((row, i) => row === candidateRows[i])
          ? candidateRows
          : rows
    })
  }
  return rebased
}

export function reduceSessionIncarnationMembership(
  reader: SessionUnitReader,
  panes: Iterable<string>
): void {
  for (const pane of panes) {
    const parsed = parsePaneKey(pane)
    if (!parsed) {
      reader.write('terminalPtyIncarnationsByPaneKey', pane, { present: false, value: undefined })
      continue
    }
    const layout = reader.unit('terminalLayoutsByTabId', parsed.tabId).value
    const leaves = new Set<string>()
    collectLeafIds(layout?.root ?? null, leaves)
    const allowed = layout
      ? leaves.has(parsed.leafId)
      : reader.terminalOccurrenceCount(parsed.tabId) > 0
    const prior = reader.unit('terminalPtyIncarnationsByPaneKey', pane, 'prior')
    const candidate = reader.unit('terminalPtyIncarnationsByPaneKey', pane)
    reader.write(
      'terminalPtyIncarnationsByPaneKey',
      pane,
      allowed ? (prior.present ? prior : candidate) : { present: false, value: undefined }
    )
  }
  reader.reconcileField('terminalPtyIncarnationsByPaneKey', {
    kind: 'replacement',
    present: true,
    valueWhenEmpty: 'undefined'
  })
}
