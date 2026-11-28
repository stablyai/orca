// A teammate's own tab list in a shared agent's Home, as its clients read it (person-session-tab-lists.ts).
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type {
  PersistedPersonSurface,
  PersistedPersonTab
} from '../../../../shared/orca-profiles/persisted-person-tab'
import { getHeadlessMobileSessionGroupId } from '../../terminal/surface/mobile-session-layout-projection'
import { topLevelTabId } from '../../terminal/surface/mobile-session-terminal-retirement'

/** What a person's chat tab shows, read from the chat's record; null when it is gone. */
export type PersonChatTabSource = (
  worktreeId: string,
  sessionId: string
) => { agent: StructuredAgentId; title: string; forked?: true } | null

/** A terminal, page or file a teammate opened in their agent's Home. Only their list holds it; a
 *  terminal's PTY record and a page's record carry their stamp (`holder`), which every door that
 *  places a tab in a host list or window reads. */
export type PersonSurface = PersistedPersonSurface

export type PersonTab = PersistedPersonTab

/** A person's surface row as it is now: null while its terminal or page is not there (a restart's
 *  reattach, a page its computer has not brought back yet). */
export type PersonSurfaceRow = (
  worktreeId: string,
  surface: PersonSurface
) =>
  | RuntimeMobileSessionTerminalTab
  | RuntimeMobileSessionBrowserTab
  | RuntimeMobileSessionFileTab
  | null

export type PersonTabListState = { tabs: readonly PersonTab[]; activeTabId: string | null }

export function personChatTabId(sessionId: string): string {
  return `agent-session:${sessionId}`
}

export function personTabId(tab: PersonTab): string {
  switch (tab.kind) {
    case 'chat':
      return personChatTabId(tab.sessionId)
    case 'terminal':
      return `${tab.parentTabId}::${tab.leafId}`
    case 'browser':
      return tab.browserPageId
    case 'file':
      // One tab per file and view, so opening it again shows the open one.
      return `file:${tab.mode === 'diff' ? `diff:${tab.diffSource ?? 'unstaged'}:` : ''}${tab.relativePath}`
  }
}

/** A person's list as clients read it: one group, each tab as its chat, terminal or page is now. */
export function personTabListSnapshot(
  worktreeId: string,
  list: PersonTabListState | undefined,
  version: number,
  epoch: string,
  sources: { tabOf: PersonChatTabSource; surfaceOf: PersonSurfaceRow }
): RuntimeMobileSessionTabsSnapshot {
  const { tabOf, surfaceOf } = sources
  const tabs = (list?.tabs ?? []).flatMap((held): RuntimeMobileSessionSnapshotTab[] => {
    const id = personTabId(held)
    const isActive = id === list?.activeTabId
    if (held.kind !== 'chat') {
      const row = surfaceOf(worktreeId, held)
      return row ? [{ ...row, isActive }] : []
    }
    const shown = tabOf(worktreeId, held.sessionId)
    return shown
      ? [
          {
            type: 'agent-session',
            id,
            title: shown.title,
            sessionId: held.sessionId,
            agent: shown.agent,
            ...(shown.forked ? { forked: true as const } : {}),
            isActive
          }
        ]
      : []
  })
  const active = tabs.find((tab) => tab.isActive) ?? null
  const groupId = getHeadlessMobileSessionGroupId(worktreeId)
  return {
    worktree: worktreeId,
    publicationEpoch: epoch,
    snapshotVersion: version,
    activeGroupId: tabs.length > 0 ? groupId : null,
    activeTabId: active?.id ?? null,
    activeTabType: active?.type ?? null,
    tabGroups:
      tabs.length > 0
        ? [
            {
              id: groupId,
              activeTabId: active ? topLevelTabId(active) : null,
              tabOrder: tabs.map(topLevelTabId)
            }
          ]
        : [],
    tabs
  }
}
