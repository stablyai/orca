import { TerminalIdentityHandoff } from './terminal-identity-handoff'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import type { TerminalLayoutSnapshot } from '../../shared/workspace-layout/terminal-tab-types'
import type { LegacyTerminalIdentityClaims } from '../persistence/loading-store/legacy-terminal-identity-claims'
import { retireRemovedScopedTerminalRow } from './legacy-terminal-retirement'

export function collectRetainedTerminalLeaves(
  layout: TerminalLayoutSnapshot | undefined,
  leaves: Set<string>
): void {
  const visit = (node: TerminalLayoutSnapshot['root']): void => {
    if (node?.type === 'leaf') {
      leaves.add(node.leafId)
    } else if (node) {
      visit(node.first)
      visit(node.second)
    }
  }
  visit(layout?.root ?? null)
}

export function visibleTerminalRowIds(
  workspace: string,
  prior: WorkspaceSessionState,
  next: WorkspaceSessionState
): Set<string> {
  const surviving = new Set((next.tabsByWorktree?.[workspace] ?? []).map((row) => row.id))
  const unified = next.unifiedTabs?.[workspace]
  if (unified) {
    const shown = new Set(
      unified.filter((tab) => tab.contentType === 'terminal').map((tab) => tab.entityId)
    )
    for (const tab of prior.unifiedTabs?.[workspace] ?? []) {
      if (tab.contentType === 'terminal' && !shown.has(tab.entityId)) {
        surviving.delete(tab.entityId)
      }
    }
  }
  return surviving
}

/** Only accepted removal retires processes; moves retain the leaf in the destination. */
export function retireRemovedTerminalWorkspace(
  authority: LegacyTerminalIdentityClaims,
  workspace: string,
  prior: WorkspaceSessionState,
  next: WorkspaceSessionState,
  affectedTabIds?: readonly string[]
): (() => void) | undefined {
  if (!authority.isLocalWorkspace(workspace)) {
    return
  }
  const handoff = new TerminalIdentityHandoff()
  const ids = affectedTabIds ?? [
    ...new Set([
      ...(prior.tabsByWorktree?.[workspace] ?? []).map((row) => row.id),
      ...(next.tabsByWorktree?.[workspace] ?? []).map((row) => row.id)
    ])
  ]
  for (const id of ids) {
    handoff.observe('before', workspace, id, prior)
    handoff.observe('after', workspace, id, next)
  }
  const undo = handoff.apply(authority)
  if (affectedTabIds) {
    const retained = handoff.retained
    for (const tabId of affectedTabIds) {
      const layout = next.terminalLayoutsByTabId?.[tabId]
      if (layout) {
        authority.observeLayout(workspace, tabId, layout)
      }
    }
    for (const id of affectedTabIds) {
      retireRemovedScopedTerminalRow(
        authority,
        workspace,
        { id },
        prior,
        next,
        !!next.terminalLayoutsByTabId?.[id]?.root,
        retained
      )
    }
    return undo
  }
  const retained = handoff.retained
  const nextRows = new Map((next.tabsByWorktree?.[workspace] ?? []).map((row) => [row.id, row]))
  const priorRows = prior.tabsByWorktree?.[workspace] ?? []
  const surviving = visibleTerminalRowIds(workspace, prior, next)
  for (const row of nextRows.values()) {
    authority.observeRow(
      workspace,
      row,
      next.terminalLayoutsByTabId?.[row.id],
      next.remoteSessionIdsByTabId?.[row.id]
    )
  }
  for (const row of priorRows) {
    retireRemovedScopedTerminalRow(
      authority,
      workspace,
      row,
      prior,
      next,
      surviving.has(row.id),
      retained
    )
  }
  return undo
}
