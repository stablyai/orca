import type { PtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import { parsePtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { parseRemoteRuntimePtyId } from '../../shared/remote-runtime-pty-id'
import { makePaneKey } from '../../shared/stable-pane-id'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../shared/workspace-scope'

export type PtyOwnershipTransferDestinationOutputRoute = Readonly<{
  runtimeId: string
  inspectPty: (ptyId: string) => Readonly<{
    incarnationId: string | null
    worktreeId: string
    connectionId: string | null
    tabId: string | null
    paneKey: string | null
  }> | null
}>

/** Rejects a destination binding that is not the exact tracked terminal surface. */
export function validatePtyOwnershipTransferDestinationOutputRoute(
  route: PtyOwnershipTransferDestinationOutputRoute,
  identity: PtyOwnershipTransferWireIdentity,
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
): void {
  const binding = parsePtyOwnershipTransferSurfaceBinding(surfaceBinding)
  const parsedPty = parseDestinationPty(binding.ptyId)
  const workspace = parseWorkspaceKey(binding.workspaceKey)
  if (
    identity.destinationRuntimeId !== route.runtimeId ||
    !parsedPty ||
    !workspace ||
    binding.executionHostId !== parsedPty.executionHostId ||
    parsedPty.terminalId !== identity.terminalId
  ) {
    throw new Error('pty_ownership_transfer_destination_output_route_mismatch')
  }
  const tracked = route.inspectPty(binding.ptyId)
  const ownerWorkspaceId =
    workspace.type === 'worktree'
      ? workspace.worktreeId
      : folderWorkspaceKey(workspace.folderWorkspaceId)
  if (
    !tracked ||
    tracked.incarnationId !== identity.incarnationId ||
    tracked.connectionId !== parsedPty.connectionId ||
    tracked.worktreeId !== ownerWorkspaceId ||
    tracked.tabId !== binding.tabId ||
    tracked.paneKey !== makePaneKey(binding.tabId, binding.leafId)
  ) {
    throw new Error('pty_ownership_transfer_destination_output_route_mismatch')
  }
}

function parseDestinationPty(ptyId: string): Readonly<{
  terminalId: string
  executionHostId: ExecutionHostId
  connectionId: string | null
}> | null {
  const ssh = parseAppSshPtyId(ptyId)
  if (ssh) {
    return {
      terminalId: ssh.relayPtyId,
      executionHostId: toSshExecutionHostId(ssh.connectionId),
      connectionId: ssh.connectionId
    }
  }
  const remote = parseRemoteRuntimePtyId(ptyId)
  if (remote) {
    if (!remote.environmentId || !remote.handle) {
      return null
    }
    return {
      terminalId: remote.handle,
      executionHostId: toRuntimeExecutionHostId(remote.environmentId),
      connectionId: null
    }
  }
  return ptyId
    ? { terminalId: ptyId, executionHostId: LOCAL_EXECUTION_HOST_ID, connectionId: null }
    : null
}
