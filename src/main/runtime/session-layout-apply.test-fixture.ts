// Main's `layout.apply` on a stored partition, as the Store applies it, for runtime tests whose
// store is a plain session map (a layout-owner build saves a chat's tab through it).
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { LayoutCommand } from '../../shared/workspace-layout/workspace-layout-command-types'
import { applyCommandToSession } from '../persistence/terminal-topology/terminal-pane-admission'
import { resolveHostId } from '../persistence/loading-store/session-host-partitions'

export function layoutApplyOn(
  get: (hostId: string) => WorkspaceSessionState | null,
  set: (next: WorkspaceSessionState, hostId: string) => void
) {
  return async (command: LayoutCommand, hostIds?: readonly string[]) => {
    const hostId = resolveHostId(hostIds?.[0])
    const session = get(hostId)
    if (!session) {
      return { ok: false as const, code: 'workspace_not_found' as const }
    }
    const change = applyCommandToSession(hostId, session, command)
    if (change.session) {
      set(change.session, hostId)
    }
    return change.value
  }
}

/** Main queues a host's chat tab commands; this lets them land. */
export const chatTabCommandsSettled = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0))
