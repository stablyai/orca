import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { resolveTerminalTabViewMode } from '../../shared/terminal-tab-view-mode'
import { terminalLayoutNodeLeafIds } from '../../shared/native-chat-leaf-ownership'
import {
  isComposerChatTarget,
  type NativeChatTargetRead
} from '../../shared/native-chat-target-read'

/**
 * A headless host's committed answer for a composer write to `ptyId`, read from persistence at the
 * write point (never from a published row): the pane bound to the PTY must still be its tab's chat
 * target.
 */
export function readHeadlessNativeChatTarget(
  session: WorkspaceSessionState | null | undefined,
  worktreeId: string,
  ptyId: string,
  tokenFor: (tabId: string) => string
): NativeChatTargetRead {
  for (const row of session?.tabsByWorktree[worktreeId] ?? []) {
    const layout = session?.terminalLayoutsByTabId?.[row.id]
    const leafIds = terminalLayoutNodeLeafIds(layout?.root)
    const boundLeaf =
      Object.entries(layout?.ptyIdsByLeafId ?? {}).find(
        ([leafId, boundPtyId]) =>
          boundPtyId === ptyId && (leafIds.length === 0 || leafIds.includes(leafId))
      )?.[0] ?? (leafIds.length <= 1 && row.ptyId === ptyId ? (leafIds[0] ?? '') : null)
    if (boundLeaf === null) {
      continue
    }
    const unified = session?.unifiedTabs?.[worktreeId]?.find(
      (tab) => tab.id === row.id || tab.entityId === row.id
    )
    return isComposerChatTarget({
      viewMode: resolveTerminalTabViewMode(unified, row),
      chatLeafId: layout?.chatLeafId,
      launchAgent: row.launchAgent,
      leafIds,
      leafId: boundLeaf
    })
      ? { kind: 'chat-target', presentationToken: tokenFor(row.id) }
      : { kind: 'not-chat-target' }
  }
  return { kind: 'unknown-target' }
}
