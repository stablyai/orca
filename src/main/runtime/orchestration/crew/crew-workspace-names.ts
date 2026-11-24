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
  scope?: CrewWorkspaceNamesScope,
  /** Remembers where the scope's tabs live, so a write reads those worktrees alone. */
  located?: CrewWorktreeLocations
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
  const worktrees = located ? locateCrewWorktrees(session, scope, located) : null
  // Without a location cache, ids are compared in place; only matching tabs are copied.
  const matching = <T>(
    byWorktree: Record<string, T[]> | undefined,
    keep: (entry: T) => boolean
  ) => {
    const found: [string, T[]][] = []
    for (const id of worktrees ?? Object.keys(byWorktree ?? {})) {
      const kept = byWorktree?.[id]?.filter(keep) ?? []
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

/** Where each tab and chat a crew shows lives: worktree id, or null when absent. */
export type CrewWorktreeLocations = Map<string, string | null>

/** The worktrees holding the scope's tabs and chats; walks every worktree only when one has moved or appeared. */
export function locateCrewWorktrees(
  session: WorkspaceSessionState,
  scope: Pick<CrewRelevance, 'tabs' | 'sessions'>,
  located: CrewWorktreeLocations
): string[] {
  const holds = (worktree: string, id: string) =>
    Boolean(
      session.tabsByWorktree?.[worktree]?.some((tab) => tab.id === id) ||
      session.unifiedTabs?.[worktree]?.some((tab) => tab.entityId === id)
    )
  const ids = [...scope.tabs, ...scope.sessions]
  const stale = ids.some((id) => {
    const worktree = located.get(id)
    return worktree === undefined || (worktree !== null && !holds(worktree, id))
  })
  if (stale) {
    const wanted = new Set(ids)
    located.clear()
    for (const [worktree, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
      for (const tab of tabs) {
        if (wanted.has(tab.id)) {
          located.set(tab.id, worktree)
        }
      }
    }
    for (const [worktree, tabs] of Object.entries(session.unifiedTabs ?? {})) {
      for (const tab of tabs) {
        if (wanted.has(tab.entityId)) {
          located.set(tab.entityId, worktree)
        }
      }
    }
    for (const id of ids) {
      if (!located.has(id)) {
        located.set(id, null)
      }
    }
  }
  const worktrees = new Set<string>()
  for (const id of ids) {
    const worktree = located.get(id)
    if (worktree) {
      worktrees.add(worktree)
    }
  }
  return [...worktrees]
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
