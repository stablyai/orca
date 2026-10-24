/** Redirect live structured handles to their equivalent operation rather than falsely reporting terminal_handle_stale.
 * terminal.show must not invent PTY/leaf/runtime ids that make read-only identity look writable. */

import type { OrchestrationDb } from './orchestration/db'
import { resolveStructuredWorkerAuthority } from './structured-worker-authority'

const TERMINAL_HANDLE_STALE = 'terminal_handle_stale'
const AGENT_SESSION_HAS_NO_TERMINAL = 'terminal_unsupported_for_agent_session'

export function structuredWorkerTerminalRefusal(
  handle: string,
  db: OrchestrationDb | null | undefined
): Error {
  if (!resolveStructuredWorkerAuthority(handle, db)) {
    return new Error(TERMINAL_HANDLE_STALE)
  }
  const error = new Error(
    `${handle} is an agent session, not a terminal, so terminal commands cannot address it. ` +
      'Read its output with `orca terminal read` or `orca orchestration worker-read --source transcript`, ' +
      'send it work with `orca orchestration send`, and open it from its chat tab.'
  )
  Object.assign(error, { code: AGENT_SESSION_HAS_NO_TERMINAL })
  return error
}
