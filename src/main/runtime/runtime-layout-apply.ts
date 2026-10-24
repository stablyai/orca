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
        | { type: 'setGroupRatios' }
        | { type: 'closeTabs'; tabIds: [string] }
        // A browser tab's record lives in its workspace's partition, so it routes by workspace.
        | { browserTabId: string }
        | { type: 'moveTabToWorkspace' }
        // Editor tabs live in their workspace's routed partition.
        | { type: 'renameEditorFiles' }
        // So does the workspace's default-tabs mark, which no tab carries.
        | { type: 'setDefaultTabsApplied' | 'applyDefaultTabs' }
      ))

export type LayoutCommandRunOptions = NonNullable<
  Parameters<NonNullable<RuntimeStore['applyLayoutCommand']>>[2]
>

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
  onPaneMoved: (move: TerminalLeafMoveRequest) => void = () => {},
  /** Layout-owner build: main's live facts in, the command's effects out (never in the reply). */
  run?: LayoutCommandRunOptions
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
  if (command.type === 'renameEditorFiles' && command.alsoIn) {
    return renameEditorFilesInWorkspaces(store, hostIdsFor, command)
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
    // close, records it, and stops nothing (a terminal another tab shares must live on). A sender
    // that asks main to refuse pinned tabs (the CLI, new phones) gets that refusal, not the force.
    // Read before the close drops the tab's record.
    const terminalTabId = terminalIdOf(store, hostIds[0], command.workspace, command.tabIds[0])
    const reply = await store.applyLayoutCommand(
      { ...command, force: command.refusePinned ? command.force === true : true },
      holders
    )
    // Only a tab the close took: a refused (pinned) tab's launches still finish into it.
    if (
      command.recordClose === 'user' &&
      reply.ok &&
      reply.result.closed?.includes(command.tabIds[0])
    ) {
      markAgentLaunchesClosedByUser(command.workspace, { kind: 'tab', tabId: terminalTabId })
    }
    // Why: a workspace main lacks has no tab to close; the window drops the tab as for tab_not_found.
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
  if (command.type !== 'closePane') {
    // A pane's sleeping record lives with the pane, in each partition that holds its tab.
    const target = command.type === 'sleep' || command.type === 'wake' ? holders : [hostIds[0]]
    return run
      ? store.applyLayoutCommand(command, target, run)
      : store.applyLayoutCommand(command, target)
  }
  const { workspace, tabId, leafId } = command
  // A launch still starting in the pane the user closed stops, and says so (as the legacy close).
  markAgentLaunchesClosedByUser(workspace, { kind: 'pane', tabId, leafId })
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

/**
 * One disk move's renames across workspaces, each partition's in one command, all in one durable
 * write: written everywhere or nowhere. A workspace a paired server owns refuses the whole.
 */
async function renameEditorFilesInWorkspaces(
  store: RuntimeStore,
  hostIdsFor: (worktreeId: string, tabId: string | null) => ExecutionHostId[],
  command: CommandOf<'renameEditorFiles'>
): Promise<LayoutApplyReply> {
  const parts = [
    { workspace: command.workspace, renames: command.renames },
    ...(command.alsoIn ?? [])
  ]
  if (parts.some((part) => isWslMoveWorkspaceSessionFrozen(part.workspace))) {
    return { ok: false, code: 'wsl_move_in_progress' }
  }
  const batches: { hostId: ExecutionHostId; command: CommandOf<'renameEditorFiles'> }[] = []
  for (const part of parts) {
    const [hostId] = hostIdsFor(part.workspace, null)
    if (!hostId || parseExecutionHostId(hostId)?.kind === 'runtime') {
      return { ok: false, code: 'host_not_owned' }
    }
    const batch = batches.find((entry) => entry.hostId === hostId)
    if (batch) {
      batch.command = { ...batch.command, alsoIn: [...(batch.command.alsoIn ?? []), part] }
    } else {
      batches.push({ hostId, command: { type: 'renameEditorFiles', ...part } })
    }
  }
  const [only] = batches
  if (batches.length === 1 && only) {
    if (!store.applyLayoutCommand) {
      throw new Error('layout_store_unavailable')
    }
    return store.applyLayoutCommand(only.command, [only.hostId])
  }
  if (!store.applyEditorFileRenamesAcrossPartitions) {
    throw new Error('layout_store_unavailable')
  }
  return store.applyEditorFileRenamesAcrossPartitions(batches)
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
