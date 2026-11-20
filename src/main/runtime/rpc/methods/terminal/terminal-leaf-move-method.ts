import { parseRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../../../shared/workspace-layout/terminal-topology/terminal-leaf-move'

type TerminalLeafMoveRuntime = {
  resolveLiveLeafForHandle(handle: string): { ptyId: string | null } | null
  moveTerminalLeafToNewTab(request: TerminalLeafMoveRequest): Promise<TerminalLeafMoveResult>
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
  const result = await runtime.moveTerminalLeafToNewTab({ ...request, ptyId })
  // Keep the renderer's environment-scoped identity outside the host's private PTY namespace.
  return result.status === 'moved' ? { ...result, ptyId: request.ptyId } : result
}
