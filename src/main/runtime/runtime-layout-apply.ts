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

/** Route tab commands to their holding partitions; group trees and browser records use the workspace partition. */
export type WindowLayoutCommand =
  | RenameTabsCommand
  | (LayoutCommand &
      (
        | { tabId: string }
        | { type: 'setGroupRatios' }
        | { type: 'closeTabs'; tabIds: [string] }
        | { browserTabId: string }
        | { type: 'moveTabToWorkspace' }
        | { type: 'renameEditorFiles' }
        | { type: 'setDefaultTabsApplied' | 'applyDefaultTabs' }
      ))

export type LayoutCommandRunOptions = NonNullable<
  Parameters<NonNullable<RuntimeStore['applyLayoutCommand']>>[2]
>

/** Apply to tab holders, routed partition first; workspace commands use its partition. Only main records user closes.
 * Preserve desktop pane-move rules and refuse WSL-move-paused workspaces whose writes would be dropped. */
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
    // Refuse a dropped target write before source gives up its tab.
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
  // Paired servers keep mirrored layout until they advertise ownership.
  if (!hostIds[0] || parseExecutionHostId(hostIds[0])?.kind === 'runtime') {
    return { ok: false, code: 'host_not_owned' }
  }
  if (!store.applyLayoutCommand) {
    throw new Error('layout_store_unavailable')
  }
  // Legacy relay reattach can leave one tab in two partitions; update every holder.
  const holders = hostIds.filter((hostId) => parseExecutionHostId(hostId)?.kind !== 'runtime')
  if (command.type === 'closeTabs') {
    // Window closes already confirmed/stopped terminals: force removal without killing shared PTYs. Honor pinned-tab refusals from CLI/new phones.
    // Read intent before close removes the record.
    const terminalTabId = terminalIdOf(store, hostIds[0], command.workspace, command.tabIds[0])
    const reply = await store.applyLayoutCommand(
      { ...command, force: command.refusePinned ? command.force === true : true },
      holders
    )
    // Cancel launches only for tabs actually closed; refused pinned tabs still receive theirs.
    if (
      command.recordClose === 'user' &&
      reply.ok &&
      reply.result.closed?.includes(command.tabIds[0])
    ) {
      markAgentLaunchesClosedByUser(command.workspace, { kind: 'tab', tabId: terminalTabId })
    }
    // Missing workspaces have no tab to close; let windows handle this as tab_not_found.
    return reply.ok && reply.result.alreadyClosed
      ? { ok: false, code: 'workspace_not_found' }
      : reply
  }
  if (command.type === 'movePaneToNewTab') {
    const sourceTabId = terminalIdOf(store, hostIds[0], command.workspace, command.tabId)
    const reply = await store.applyLayoutCommand(
      {
        ...command,
        // Main mints destination tab ids; discard the window's proposed id.
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
      // Move already committed; throwing would make the window repeat it through the legacy path.
      try {
        onPaneMoved(move)
      } catch (error) {
        console.warn('[layout] moved pane kept some of its old keys:', error)
      }
    }
    return reply
  }
  if (command.type !== 'closePane') {
    // Move sleeping records with panes in every holding partition.
    const target = command.type === 'sleep' || command.type === 'wake' ? holders : [hostIds[0]]
    return run
      ? store.applyLayoutCommand(command, target, run)
      : store.applyLayoutCommand(command, target)
  }
  const { workspace, tabId, leafId } = command
  // Cancel pending launches in user-closed panes, as legacy close did.
  markAgentLaunchesClosedByUser(workspace, { kind: 'pane', tabId, leafId })
  return store.applyLayoutCommand(
    { type: 'closePane', workspace, tabId, leafId, userPaneClose: true },
    holders
  )
}

/** Rename in each tab's routed partition in one durable write; untitled reports the same refusal codes as renameTab. */
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

/** Move groups within/across holding partitions atomically; window save no longer carries the move. */
async function moveTabToWorkspace(
  store: RuntimeStore,
  hostIdsFor: (worktreeId: string, tabId: string | null) => ExecutionHostId[],
  command: CommandOf<'moveTabToWorkspace'>
): Promise<LayoutApplyReply> {
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

/** Rename disk-move paths across partitions in one durable write; paired-server ownership refuses the whole operation. */
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
