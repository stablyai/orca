// A window's drag-out through `layout.apply`, checked across partitions as the desktop's move
// (planTerminalLeafMove) is, before any partition is written.

import { randomUUID } from 'node:crypto'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { layoutContainsLeafId } from '../../../shared/workspace-layout/terminal-pane-tree'
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
      /** The command every holder applies: one new tab id and one terminal for the pane. */
      command: WindowPaneDetachCommand & { windowDetach: { tabId: string } }
      /** The source tab's terminal id (the tab half of the moved pane's old key). */
      sourceEntityId: string
    }
  | { code: LayoutRefusalCode }
  /** No partition holds the pane; the routed apply refuses it. */
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
      ? [{ entityId: tab.entityId, ptyId: workspace.leaves?.[leafId]?.ptyId }]
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
  const bound = new Set(holders.flatMap(({ ptyId }) => (ptyId ? [ptyId] : [])))
  // The window's live terminal wins: after an SSH respawn one copy can still name the old one.
  const ptyId = command.windowDetach.ptyId ?? (bound.size === 1 ? [...bound][0]! : null)
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
