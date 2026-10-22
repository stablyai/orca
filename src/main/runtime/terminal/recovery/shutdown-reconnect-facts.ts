// Layout-owner build: what the next startup reconnects, derived by main from its own layout, its
// terminal records and its SSH connections, never taken from a window's save. The rules are the
// window's (buildTerminalSessionData, buildActiveConnectionIdsAtShutdown), read from main's state.

import { isPaneSleepRecord } from '../../../../shared/agent-session-resume'
import { isOwnedSshTargetId } from '../../../../shared/execution-host'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-pane-tree'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'

export type ShutdownReconnectFacts = Pick<
  WorkspaceSessionState,
  'activeWorktreeIdsOnShutdown' | 'remoteSessionIdsByTabId' | 'activeConnectionIdsAtShutdown'
>

export type ReconnectFactSources = {
  /** A terminal of this machine main's records show running. */
  isLiveLocalPty: (ptyId: string) => boolean
  /** Proven exited (a recorded exit); a lost relay is unverifiable, not exited. */
  isKnownExited: (ptyId: string) => boolean
  sshStatusByTargetId: ReadonlyMap<string, SshConnectionStatus>
  /** The other partitions' sessions: the connection list is global across them. */
  otherPartitions?: () => readonly WorkspaceSessionState[]
}

/** Every terminal a tab's panes name, in tree order, then its tab-level id. */
function tabPtyIds(session: WorkspaceSessionState, tabId: string, tabPtyId: string | null) {
  const layout = session.terminalLayoutsByTabId[tabId]
  const byLeaf = layout?.ptyIdsByLeafId ?? {}
  const leafIds = collectLayoutLeafIdsInOrder(layout?.root ?? null)
  const records = session.sleepingAgentSessionsByPaneKey ?? {}
  // A running agent's live or quit resume record is not a sleep.
  const slept = (leafId: string | undefined): boolean => {
    const record = leafId ? records[`${tabId}:${leafId}`] : undefined
    return record !== undefined && isPaneSleepRecord(record)
  }
  const panes = leafIds.flatMap((leafId) => {
    const ptyId = byLeaf[leafId]
    return ptyId ? [{ ptyId, sleeping: slept(leafId) }] : []
  })
  // A tab-level id is its single pane's: slept when that pane is.
  if (tabPtyId && !panes.some((pane) => pane.ptyId === tabPtyId)) {
    const solePaneSleeping = leafIds.length === 1 && slept(leafIds[0])
    panes.push({ ptyId: tabPtyId, sleeping: solePaneSleeping })
  }
  return panes
}

/** Tab id → the relay session it reconnects: an awake pane's, not proven exited. */
function relaySessionIdsByTabId(
  session: WorkspaceSessionState,
  sources: ReconnectFactSources
): Record<string, string> {
  const relays: Record<string, string> = {}
  for (const tabs of Object.values(session.tabsByWorktree)) {
    for (const tab of tabs) {
      // A slept pane keeps its relay id as a wake hint; only an awake one reconnects.
      const relay = tabPtyIds(session, tab.id, tab.ptyId).find(
        (pane) =>
          !pane.sleeping && parseAppSshPtyId(pane.ptyId) && !sources.isKnownExited(pane.ptyId)
      )
      if (relay) {
        relays[tab.id] = relay.ptyId
      }
    }
  }
  return relays
}

export function deriveShutdownReconnectFacts(
  session: WorkspaceSessionState,
  sources: ReconnectFactSources
): ShutdownReconnectFacts {
  const relays = relaySessionIdsByTabId(session, sources)
  const activeWorktreeIds = Object.entries(session.tabsByWorktree)
    .filter(([, tabs]) =>
      tabs.some(
        (tab) =>
          Boolean(relays[tab.id]) ||
          tabPtyIds(session, tab.id, tab.ptyId).some((pane) => sources.isLiveLocalPty(pane.ptyId))
      )
    )
    .map(([worktreeId]) => worktreeId)
  const everyRelay = [
    ...Object.values(relays),
    ...(sources.otherPartitions?.() ?? []).flatMap((other) =>
      Object.values(relaySessionIdsByTabId(other, sources))
    )
  ]
  return {
    activeWorktreeIdsOnShutdown: activeWorktreeIds,
    remoteSessionIdsByTabId: Object.keys(relays).length > 0 ? relays : undefined,
    activeConnectionIdsAtShutdown: activeConnectionIds(sources, everyRelay)
  }
}

/**
 * Connected targets, and the targets a surviving relay session names unless the user left them
 * offline. A runtime-owned target belongs to the runtime layer and is never redialed.
 */
function activeConnectionIds(
  sources: ReconnectFactSources,
  relaySessionIds: readonly string[]
): string[] | undefined {
  const targetIds = new Set<string>()
  for (const [targetId, status] of sources.sshStatusByTargetId) {
    if (status === 'connected' && !isOwnedSshTargetId(targetId)) {
      targetIds.add(targetId)
    }
  }
  for (const sessionId of relaySessionIds) {
    const targetId = parseAppSshPtyId(sessionId)?.connectionId
    const status = targetId ? sources.sshStatusByTargetId.get(targetId) : undefined
    if (
      targetId &&
      !isOwnedSshTargetId(targetId) &&
      status &&
      status !== 'disconnected' &&
      status !== 'auth-failed'
    ) {
      targetIds.add(targetId)
    }
  }
  return targetIds.size > 0 ? [...targetIds] : undefined
}
