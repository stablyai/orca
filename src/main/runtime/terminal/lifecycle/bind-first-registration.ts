// Bind panes before registration so main can resolve them immediately; unbound registration throws in tests/dev and ships without a pane.

import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

export function assertPaneBoundAtRegistration(
  ptyId: string,
  claimedPaneKey: string,
  boundPaneKey: string | null
): void {
  if (boundPaneKey !== null) {
    return
  }
  const message = `pane_unbound_at_registration: ${ptyId} registered for ${claimedPaneKey} before main's layout bound it`
  if (process.env.NODE_ENV === 'test') {
    throw new Error(message)
  }
  if (process.env.NODE_ENV === 'development') {
    console.error(`[layout] ${message}`)
  }
}

/** A paired server's workspace: main's index leaves it out, as that server owns its layout. */
export function isRuntimeHostedWorkspace(hostId: ExecutionHostId | null): boolean {
  return hostId !== null && parseExecutionHostId(hostId)?.kind === 'runtime'
}
