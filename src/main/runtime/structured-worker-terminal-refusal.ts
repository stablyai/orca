/**
 * What a terminal verb should say when handed a structured worker's handle.
 *
 * `terminal_handle_stale` is a claim that the handle went dead, and for a structured worker it is
 * simply false: the session is live, it has no terminal, and it never had one. Callers acting on
 * that claim went looking for a remint that cannot exist. The refusal names the structured
 * equivalent instead, so an agent that lands here knows what to run rather than what failed.
 *
 * `terminal.show` stays non-resolving on purpose: synthesising a `ptyId`/`leafId`/`paneRuntimeId`
 * would hand every public terminal verb something that looks writable and is not.
 */

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
