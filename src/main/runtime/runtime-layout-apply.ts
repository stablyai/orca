import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type {
  CommandOf,
  LayoutApplyReply,
  LayoutCommand,
  RenameTabsCommand,
  UntitledTab
} from '../../shared/workspace-layout/workspace-layout-command-types'
import type { TerminalLeafMoveRequest } from '../../shared/terminal-leaf-move'
import { renameTabCommandsOf } from '../../shared/workspace-layout/workspace-layout-commands'
import { markAgentLaunchesClosedByUser } from '../agent-launch/agent-launch-pane-attachment'
import { isWslMoveWorkspaceSessionFrozen } from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import type { RuntimeStore } from './runtime-store-contract'

/**
 * A window's layout command: one on a tab, which names its partitions, or on the group tree or a
 * browser tab's record, which go to the workspace's routed partition.
 */
export type WindowLayoutCommand =
  | RenameTabsCommand
  | (LayoutCommand &
      (
        | { tabId: string }
        // `automatic`: not the user's close; its terminal ended.
        | { type: 'closePane'; tabId: string; automatic?: true }
        | { type: 'setGroupRatios' }
        | { type: 'closeTabs'; tabIds: [string] }
        // A browser tab's record lives in its workspace's partition, so it routes by workspace.
        | { browserTabId: string }
        | { type: 'moveTabToWorkspace' }
        // Editor tabs live in their workspace's routed partition.
        | { type: 'renameEditorFiles' }
        // So does the workspace's default-tabs mark, which no tab carries.
        | { type: 'setDefaultTabsApplied' }
      ))

/**
 * `layout.apply`: the window's command on the partitions holding its tab, routed partition first;
 * a group tree command goes to the workspace's routed partition. A pane close is the user's: main
 * marks it so, and the window cannot. A pane moved to a new tab follows the desktop's move rules.
 * A workspace a WSL move has paused is refused: its write would be dropped and the change revert.
 */
export async function applyWindowLayoutCommand(
  store: RuntimeStore,
  hostIdsFor: (worktreeId: string, tabId: string | null) => ExecutionHostId[],
  command: WindowLayoutCommand,
  /** Agent status and orchestration records follow a pane moved into a new tab. */
  onPaneMoved: (move: TerminalLeafMoveRequest) => void = () => {}
): Promise<LayoutApplyReply> {
  if (command.type === 'renameTabs') {
    return renameTabs(store, hostIdsFor, command)
  }
  if (
    isWslMoveWorkspaceSessionFrozen(command.workspace) ||
    // The target's dropped write would lose the tab the source gave up.
    (command.type === 'moveTabToWorkspace' && isWslMoveWorkspaceSessionFrozen(command.toWorkspace))
  ) {
    return { ok: false, code: 'wsl_move_in_progress' }
  }
  if (command.type === 'moveTabToWorkspace') {
    return moveTabToWorkspace(store, hostIdsFor, command)
  }
  const routedTabId =
    'tabId' in command
      ? (command.tabId ?? null)
      : command.type === 'closeTabs'
        ? command.tabIds[0]
        : null
  const hostIds = hostIdsFor(command.workspace, routedTabId)
  // Why: a paired server's workspaces keep today's mirrored layout until that server owns it.
  if (!hostIds[0] || parseExecutionHostId(hostIds[0])?.kind === 'runtime') {
    return { ok: false, code: 'host_not_owned' }
  }
  if (!store.applyLayoutCommand) {
    throw new Error('layout_store_unavailable')
  }
  // Why every holder: a legacy relay reattach can leave one tab in two partitions.
  const holders = hostIds.filter((hostId) => parseExecutionHostId(hostId)?.kind !== 'runtime')
  if (command.type === 'closeTabs') {
    // The window already confirmed, removed the tab and stopped its terminals: main forces the
    // close, records it, and stops nothing (a terminal another tab shares must live on).
    if (command.recordClose === 'user') {
      const tabId = terminalIdOf(store, hostIds[0], command.workspace, command.tabIds[0])
      markAgentLaunchesClosedByUser(command.workspace, { kind: 'tab', tabId })
    }
    const reply = await store.applyLayoutCommand({ ...command, force: true }, holders)
    // Why: a workspace main lacks has no partition record to write; the window already removed the tab.
    return reply.ok && reply.result.alreadyClosed
      ? { ok: false, code: 'workspace_not_found' }
      : reply
  }
  if (command.type === 'movePaneToNewTab') {
    // Read before the move, which re-homes the pane.
    const sourceTabId = terminalIdOf(store, hostIds[0], command.workspace, command.tabId)
    const reply = await store.applyLayoutCommand(
      {
        ...command,
        // Why: main mints the new tab's id, so the window's is not carried.
        windowDetach: {
          ptyId: command.windowDetach?.ptyId ?? null,
          ...(command.windowDetach?.startupCwd
            ? { startupCwd: command.windowDetach.startupCwd }
            : {})
        }
      },
      holders
    )
    if (reply.ok && reply.result.tabId) {
      const move = {
        worktreeId: command.workspace,
        sourceTabId,
        targetTabId: reply.result.tabId,
        leafId: command.leafId,
        ptyId: reply.result.ptyId ?? null
      }
      // Why: the move is committed; a throw here would send the window to today's move as well.
      try {
        onPaneMoved(move)
      } catch (error) {
        console.warn('[layout] moved pane kept some of its old keys:', error)
      }
    }
    return reply
  }
  // A pane's sleeping record lives with the pane, in each partition that holds its tab.
  if (command.type === 'sleep' || command.type === 'wake') {
    return store.applyLayoutCommand(command, holders)
  }
  if (command.type !== 'closePane') {
    return store.applyLayoutCommand(command, [hostIds[0]])
  }
  const { workspace, tabId, leafId } = command
  // A launch still starting in the pane the user closed stops, and says so (as the legacy close).
  if (!('automatic' in command && command.automatic)) {
    markAgentLaunchesClosedByUser(workspace, { kind: 'pane', tabId, leafId })
  }
  return store.applyLayoutCommand(
    { type: 'closePane', workspace, tabId, leafId, userPaneClose: true },
    holders
  )
}

/**
 * Each title in its tab's routed partition, as a `renameTab` would be, all in one durable write;
 * a title main cannot give is named in `untitled` with the code its own `renameTab` would get.
 */
async function renameTabs(
  store: RuntimeStore,
  hostIdsFor: (worktreeId: string, tabId: string | null) => ExecutionHostId[],
  command: RenameTabsCommand
): Promise<LayoutApplyReply> {
  const untitled: UntitledTab[] = []
  const byHost = new Map<ExecutionHostId, CommandOf<'renameTab'>[]>()
  for (const rename of renameTabCommandsOf(command)) {
    const { workspace, tabId } = rename
    const [hostId] = hostIdsFor(workspace, tabId)
    if (isWslMoveWorkspaceSessionFrozen(workspace)) {
      untitled.push({ workspace, tabId, code: 'wsl_move_in_progress' })
    } else if (!hostId || parseExecutionHostId(hostId)?.kind === 'runtime') {
      untitled.push({ workspace, tabId, code: 'host_not_owned' })
    } else {
      const renames = byHost.get(hostId) ?? []
      renames.push(rename)
      byHost.set(hostId, renames)
    }
  }
  if (byHost.size > 0) {
    if (!store.applyTabRenames) {
      throw new Error('layout_store_unavailable')
    }
    const refused = await store.applyTabRenames(
      [...byHost].map(([hostId, renames]) => ({ hostId, renames }))
    )
    untitled.push(
      ...refused.map(({ rename, code }) => ({
        workspace: rename.workspace,
        tabId: rename.tabId,
        code
      }))
    )
  }
  return { ok: true, result: untitled.length > 0 ? { untitled } : {} }
}

/**
 * Applied in the one partition holding both workspaces, or across the two that do (a local and an
 * SSH workspace) in one durable write: a window save no longer carries the move.
 */
async function moveTabToWorkspace(
  store: RuntimeStore,
  hostIdsFor: (worktreeId: string, tabId: string | null) => ExecutionHostId[],
  command: CommandOf<'moveTabToWorkspace'>
): Promise<LayoutApplyReply> {
  // An editor tab lives in its workspace's routed partition.
  const [from] = hostIdsFor(command.workspace, null)
  const [to] = hostIdsFor(command.toWorkspace, null)
  if (
    !from ||
    !to ||
    [from, to].some((hostId) => parseExecutionHostId(hostId)?.kind === 'runtime')
  ) {
    return { ok: false, code: 'host_not_owned' }
  }
  if (from !== to) {
    if (!store.moveTabToWorkspaceAcrossPartitions) {
      throw new Error('layout_store_unavailable')
    }
    return store.moveTabToWorkspaceAcrossPartitions(command, from, to)
  }
  if (!store.applyLayoutCommand) {
    throw new Error('layout_store_unavailable')
  }
  return store.applyLayoutCommand(command, [from])
}

/** A tab-bar id's terminal id, which a legacy entry's can differ from. */
function terminalIdOf(
  store: RuntimeStore,
  hostId: ExecutionHostId,
  workspace: string,
  tabId: string
): string {
  return (
    store
      .getWorkspaceSession?.(hostId)
      ?.unifiedTabs?.[workspace]?.find((entry) => entry.id === tabId)?.entityId ?? tabId
  )
}
