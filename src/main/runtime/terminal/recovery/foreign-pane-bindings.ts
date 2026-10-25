// Layout-owner build: what restore reads from each pane's stored terminal. A pane never
// reattaches to a terminal another workspace owns (the window's rule,
// deferred-session-reattach-choice.ts), and one whose local terminal is gone shows as sleeping.

import { isPtySessionIdOwnedByWorktree } from '../../../../shared/pty-session-id-format'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'

/** An SSH id names its connection, never a workspace, so only a local minted id can be foreign. */
export function isPtyIdMintedForAnotherWorkspace(ptyId: string, worktreeId: string): boolean {
  return (
    !isRemoteRuntimePtyId(ptyId) &&
    !parseAppSshPtyId(ptyId) &&
    !isPtySessionIdOwnedByWorktree(ptyId, worktreeId)
  )
}

export type PaneBinding = { worktreeId: string; tabId: string; leafId: string; ptyId: string }

/** Every pane `session` binds to a terminal minted for another workspace. */
export function panesBoundToAnotherWorkspace(session: WorkspaceSessionState): PaneBinding[] {
  return Object.entries(session.tabsByWorktree ?? {}).flatMap(([worktreeId, rows]) =>
    rows.flatMap((row) =>
      Object.entries(session.terminalLayoutsByTabId?.[row.id]?.ptyIdsByLeafId ?? {}).flatMap(
        ([leafId, ptyId]) =>
          ptyId && isPtyIdMintedForAnotherWorkspace(ptyId, worktreeId)
            ? [{ worktreeId, tabId: row.id, leafId, ptyId }]
            : []
      )
    )
  )
}

/** Pane keys of the local partition's panes bound to a local terminal `isLive` does not find. */
export function panesBoundToGoneLocalTerminals(
  session: WorkspaceSessionState,
  isLive: (ptyId: string) => boolean
): string[] {
  return Object.values(session.tabsByWorktree ?? {}).flatMap((rows) =>
    rows.flatMap((row) =>
      Object.entries(session.terminalLayoutsByTabId?.[row.id]?.ptyIdsByLeafId ?? {}).flatMap(
        ([leafId, ptyId]) =>
          // Relay and paired-server terminals live on another host, whose own census answers.
          ptyId && !isRemoteRuntimePtyId(ptyId) && !parseAppSshPtyId(ptyId) && !isLive(ptyId)
            ? [`${row.id}:${leafId}`]
            : []
      )
    )
  )
}
