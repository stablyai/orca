import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { parsePtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

export function bindOutgoingSshPtySurfaceRecord(
  records: ReadonlyMap<string, RuntimePtyWorktreeRecord>,
  ptyId: string,
  value: unknown,
  allowDisconnected = false
): () => void {
  const binding = parsePtyOwnershipTransferSurfaceBinding(value)
  const route = parseAppSshPtyId(ptyId)
  const tracked = records.get(ptyId)
  const incarnation = tracked?.incarnationId
  const assertCurrent = () => {
    const pane = tracked?.paneKey ? parsePaneKey(tracked.paneKey) : null
    const workspaceKey = tracked?.worktreeId.startsWith('folder:')
      ? tracked.worktreeId
      : worktreeWorkspaceKey(tracked?.worktreeId ?? '')
    if (
      !route ||
      !tracked ||
      !incarnation ||
      (!allowDisconnected && !tracked.connected) ||
      records.get(ptyId) !== tracked ||
      tracked.incarnationId !== incarnation ||
      tracked.connectionId !== route.connectionId ||
      binding.executionHostId !== 'local' ||
      binding.ptyId !== route.relayPtyId ||
      binding.workspaceKey !== workspaceKey ||
      binding.tabId !== tracked.tabId ||
      pane?.tabId !== binding.tabId ||
      pane.leafId !== binding.leafId
    ) {
      throw new Error('orcad_outgoing_source_surface_changed')
    }
  }
  assertCurrent()
  return assertCurrent
}
