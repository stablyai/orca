/** What a move carries, counted from its own export, so the preview's summary cannot drift from it. */
import type { WslMoveScopeCounts } from '../../../../shared/wsl-move/wsl-move-driver-types'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import type { WslMoveManifestExport } from './wsl-move-manifest-export'

export function wslMoveScopeCounts(
  exported: Pick<WslMoveManifestExport, 'manifest' | 'workspaceIds'>
): WslMoveScopeCounts {
  const session = exported.manifest.payload.dormantState?.workspaceSession
  const unified = session?.unifiedTabs ? Object.values(session.unifiedTabs).flat() : null
  // Unified tabs win on read; the legacy terminal list only stands in when they are absent.
  const terminalTabIds = new Set(
    unified
      ? unified.filter((tab) => tab.contentType === 'terminal').map((tab) => tab.entityId)
      : Object.values(session?.tabsByWorktree ?? {}).flatMap((tabs) => tabs.map((tab) => tab.id))
  )
  let terminals = 0
  for (const tabId of terminalTabIds) {
    const root = session?.terminalLayoutsByTabId?.[tabId]?.root
    terminals += Math.max(1, collectLayoutLeafIdsInOrder(root).length)
  }
  const chats = new Set(
    (unified ?? []).filter((tab) => tab.contentType === 'agent-session').map((tab) => tab.id)
  ).size
  return { workspaces: new Set(exported.workspaceIds).size, terminals, chats }
}
