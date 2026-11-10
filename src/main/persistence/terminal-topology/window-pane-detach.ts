// Validate every holder before any partition writes a renderer-requested detach.

import { randomUUID } from 'node:crypto'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  collectLayoutLeafIdsInOrder,
  layoutContainsLeafId
} from '../../../shared/workspace-layout/terminal-pane-tree'
import { findTerminal } from '../../../shared/workspace-layout/workspace-layout-command-steps'
import type {
  CommandOf,
  LayoutRefusalCode,
  WindowPaneDetach
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { leafHeldByOtherTab } from './terminal-leaf-move'
import {
  isTerminalOwnerPartition,
  type TerminalSessionPartition
} from './terminal-topology-membership'

export type WindowPaneDetachCommand = CommandOf<'movePaneToNewTab'> & {
  windowDetach: WindowPaneDetach
}

export type ResolvedWindowPaneDetach =
  | {
      /** Share one new tab ID and terminal across all holders. */
      command: WindowPaneDetachCommand & { windowDetach: { tabId: string } }
      /** Source terminal entity ID before detach changes the tab key. */
      sourceEntityId: string
    }
  | { code: LayoutRefusalCode }
  | null

export function resolveWindowPaneDetach(
  partitions: readonly TerminalSessionPartition[],
  holderIds: readonly ExecutionHostId[],
  command: WindowPaneDetachCommand
): ResolvedWindowPaneDetach {
  const { leafId } = command
  const holders = partitions.flatMap(({ hostId, session }) => {
    if (!holderIds.includes(hostId)) {
      return []
    }
    const workspace = loadWorkspaceLayout(hostId, session, nameBasedLoadContext()).layout
      .workspaces[command.workspace]
    const tab = workspace && findTerminal(workspace, command.tabId)
    return tab && layoutContainsLeafId(tab.panes.root, leafId)
      ? [
          {
            hostId,
            entityId: tab.entityId,
            ptyId: workspace.leaves?.[leafId]?.ptyId,
            panes: collectLayoutLeafIdsInOrder(tab.panes.root).length
          }
        ]
      : []
  })
  if (holders.length === 0) {
    return null
  }
  const sourceEntityId = holders[0]!.entityId
  if (
    partitions.some(
      ({ hostId, session }) =>
        isTerminalOwnerPartition(hostId) && leafHeldByOtherTab(session, sourceEntityId, leafId)
    )
  ) {
    return { code: 'pane_in_other_tab' }
  }
  const home = holders.find((holder) => holder.hostId === holderIds[0])
  // Main owns all shown panes; home determines last-pane status while stray copies move too.
  if (ORCA_LAYOUT_OWNER_IS_MAIN && home && home.panes < 2) {
    return { code: 'last_pane' }
  }
  const bound = new Set(holders.flatMap(({ ptyId }) => (ptyId ? [ptyId] : [])))
  // Main's home binding wins when SSH respawn leaves different IDs in duplicate holders.
  const ptyId = ORCA_LAYOUT_OWNER_IS_MAIN
    ? bound.size === 1
      ? [...bound][0]!
      : (home?.ptyId ?? null)
    : (command.windowDetach.ptyId ?? (bound.size === 1 ? [...bound][0]! : null))
  if (bound.size > 0 && !(ptyId && bound.has(ptyId))) {
    return { code: 'pty_mismatch' }
  }
  return {
    command: {
      ...command,
      windowDetach: {
        ...command.windowDetach,
        ptyId,
        tabId: command.windowDetach.tabId ?? randomUUID()
      }
    },
    sourceEntityId
  }
}
