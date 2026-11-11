/** Redirect live structured handles to their equivalent operation rather than falsely reporting terminal_handle_stale.
 * terminal.show must not invent PTY/leaf/runtime ids that make read-only identity look writable. */

import type { OrchestrationDb } from '../../db/orchestration-db'
import { resolveStructuredWorkerAuthority } from './structured-worker-authority'
import { parseOrcaSessionAddress } from '../../../../../shared/orca-session-address'

const TERMINAL_HANDLE_STALE = 'terminal_handle_stale'
const AGENT_SESSION_HAS_NO_TERMINAL = 'terminal_unsupported_for_agent_session'

export function structuredWorkerTerminalRefusal(
  handle: string,
  db: OrchestrationDb | null | undefined
): Error {
  if (resolveStructuredWorkerAuthority(handle, db)) {
    return agentSessionRefusal(
      `${handle} is an agent session, not a terminal, so terminal commands cannot address it. ` +
        'Read its output with `orca terminal read` or `orca orchestration worker-read --source transcript`, ' +
        'send it work with `orca orchestration send`, and open it from its chat tab.'
    )
  }
  // A chat address never names a terminal, live or not.
  if (parseOrcaSessionAddress(handle)) {
    return agentSessionRefusal(
      `${handle} is a chat session, not a terminal, so terminal commands cannot address it. ` +
        `Message it with \`orca orchestration send --to ${handle}\`.`
    )
  }
  return new Error(TERMINAL_HANDLE_STALE)
}

function agentSessionRefusal(message: string): Error {
  return Object.assign(new Error(message), { code: AGENT_SESSION_HAS_NO_TERMINAL })
}
