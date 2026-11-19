import {
  chatNameInputs,
  layoutNameInputs,
  terminalNameInputs
} from '../mailbox/senders/orchestration-sender-name'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { CrewRelevance } from './crew-changes'

/** Which naming inputs to compare: one worktree's, or only the tabs and chats crew rows show. */
export type CrewWorkspaceNamesScope =
  | { worktreeId: string }
  | Pick<CrewRelevance, 'tabs' | 'sessions'>

/** Excludes scrollback, focus, bells and other session bookkeeping from name invalidation. */
export function crewWorkspaceNames(
  session: WorkspaceSessionState | null | undefined,
  scope?: CrewWorkspaceNamesScope
) {
  if (!session) {
    return null
  }
  if (!scope) {
    return {
      tabs: Object.entries(session.tabsByWorktree ?? {}).map(([id, tabs]) => [
        id,
        tabs.map(terminalNameInputs)
      ]),
      chats: Object.entries(session.unifiedTabs ?? {}).map(([id, tabs]) => [
        id,
        tabs.map(chatNameInputs)
      ]),
      layouts: Object.entries(session.terminalLayoutsByTabId ?? {}).map(([id, layout]) => [
        id,
        layoutNameInputs(layout)
      ])
    }
  }
  if ('worktreeId' in scope) {
    const tabs = session.tabsByWorktree?.[scope.worktreeId] ?? []
    return {
      tabs: tabs.map(terminalNameInputs),
      chats: (session.unifiedTabs?.[scope.worktreeId] ?? []).map(chatNameInputs),
      layouts: layoutsFor(
        session,
        tabs.map((tab) => tab.id)
      )
    }
  }
  // Ids are compared in place; only matching tabs are copied, so unrelated worktrees allocate nothing.
  const matching = <T>(
    byWorktree: Record<string, T[]> | undefined,
    keep: (entry: T) => boolean
  ) => {
    const found: [string, T[]][] = []
    for (const id in byWorktree) {
      const kept = byWorktree[id].filter(keep)
      if (kept.length > 0) {
        found.push([id, kept])
      }
    }
    return found
  }
  return {
    tabs: matching(session.tabsByWorktree, (tab) => scope.tabs.has(tab.id)).map(([id, tabs]) => [
      id,
      tabs.map(terminalNameInputs)
    ]),
    chats: matching(session.unifiedTabs, (tab) => scope.sessions.has(tab.entityId)).map(
      ([id, tabs]) => [id, tabs.map(chatNameInputs)]
    ),
    layouts: layoutsFor(session, scope.tabs)
  }
}

function layoutsFor(session: WorkspaceSessionState, tabIds: Iterable<string>) {
  const layouts: [string, ReturnType<typeof layoutNameInputs>][] = []
  for (const id of tabIds) {
    const layout = session.terminalLayoutsByTabId?.[id]
    if (layout) {
      layouts.push([id, layoutNameInputs(layout)])
    }
  }
  return layouts
}
