// A teammate's own tab list in a shared agent's Home, as its clients read it (person-session-tab-lists.ts).
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { PersistedPersonSurface } from '../../../../shared/orca-profiles/persisted-state-types'
import { getHeadlessMobileSessionGroupId } from '../../terminal/surface/mobile-session-layout-projection'

/** What a person's chat tab shows, read from the chat's record; null when it is gone. */
export type PersonChatTabSource = (
  worktreeId: string,
  sessionId: string
) => { agent: StructuredAgentId; title: string; forked?: true } | null

/** A terminal or browser tab a teammate opened in their agent's Home. It runs on the host; only their
 *  list holds it, and holding it is its stamp (`holderOfSurface`): the host's lists never show it. */
export type PersonSurface = PersistedPersonSurface

export type PersonTab = { kind: 'chat'; sessionId: string } | PersonSurface

/** A person's surface row as it is now: null while its terminal or page is not there (a restart's
 *  reattach, a page its computer has not brought back yet). */
export type PersonSurfaceRow = (
  worktreeId: string,
  surface: PersonSurface
) => RuntimeMobileSessionTerminalTab | RuntimeMobileSessionBrowserTab | null

export type PersonTabListState = { tabs: readonly PersonTab[]; activeTabId: string | null }

export function personChatTabId(sessionId: string): string {
  return `agent-session:${sessionId}`
}

export function personTabId(tab: PersonTab): string {
  return tab.kind === 'chat'
    ? personChatTabId(tab.sessionId)
    : tab.kind === 'terminal'
      ? `${tab.parentTabId}::${tab.leafId}`
      : tab.browserPageId
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
        ? [{ id: groupId, activeTabId: active?.id ?? null, tabOrder: tabs.map((tab) => tab.id) }]
        : [],
    tabs
  }
}
