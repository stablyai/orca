import { parseRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type {
  CommandOf,
  LayoutApplyReply
} from '../../../../../shared/workspace-layout/workspace-layout-command-types'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../../../shared/workspace-layout/terminal-topology/terminal-leaf-move'

type TerminalLeafMoveRuntime = {
  resolveLiveLeafForHandle(handle: string): { ptyId: string | null } | null
  applyLayoutCommand(command: CommandOf<'movePaneToNewTab'>): Promise<LayoutApplyReply>
}

function toLeafMoveResult(
  reply: LayoutApplyReply,
  request: TerminalLeafMoveRequest
): TerminalLeafMoveResult {
  if (reply.ok) {
    return {
      status: 'moved',
      ptyId: request.ptyId,
      tabId: reply.result.tabId ?? request.targetTabId
    }
  }
  switch (reply.code) {
    case 'tab_not_found':
    case 'pane_not_found':
    case 'tab_closed':
      return { status: 'not_held' }
    case 'tab_exists':
      return { status: 'refused', reason: 'target_tab_exists' }
    case 'pty_mismatch':
      return { status: 'refused', reason: 'pty_mismatch' }
    case 'pane_in_other_tab':
      return { status: 'refused', reason: 'leaf_in_other_tab' }
    case 'last_pane':
      return { status: 'refused', reason: 'last_pane' }
    case 'invalid_params':
    case 'same_pane':
    case 'workspace_not_found':
    case 'group_not_found':
    case 'group_set_changed':
    case 'pane_structure_changed':
    case 'generated_title_kept':
      return { status: 'refused', reason: 'invalid_request' }
    case 'group_exists':
    case 'workspace_exists':
    case 'page_exists':
      return { status: 'refused', reason: 'target_tab_exists' }
    case 'pane_already_bound':
      return { status: 'refused', reason: 'leaf_in_other_tab' }
    case 'host_not_owned':
    case 'other_partition':
    case 'wsl_move_in_progress':
    case 'pane_sleeping':
      return { status: 'refused', reason: 'pane_unavailable' }
  }
}

export async function moveLeafToNewTabOnRuntime(
  runtime: TerminalLeafMoveRuntime,
  request: TerminalLeafMoveRequest
): Promise<TerminalLeafMoveResult> {
  const remote = request.ptyId ? parseRemoteRuntimePtyId(request.ptyId) : null
  // An unverified binding must not let persistence infer a different terminal to move.
  if (!remote) {
    return { status: 'refused', reason: 'pty_mismatch' }
  }
  const ptyId = runtime.resolveLiveLeafForHandle(remote.handle)?.ptyId
  if (!ptyId) {
    return { status: 'refused', reason: 'pty_mismatch' }
  }
  // The layout owner mints the destination tab; the window's target id is only a fallback.
  const reply = await runtime.applyLayoutCommand({
    type: 'movePaneToNewTab',
    workspace: request.worktreeId,
    tabId: request.sourceTabId,
    leafId: request.leafId
  })
  // Keep the renderer's environment-scoped identity outside the host's private PTY namespace.
  return toLeafMoveResult(reply, request)
}
