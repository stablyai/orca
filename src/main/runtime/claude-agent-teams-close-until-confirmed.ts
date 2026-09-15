import type { RuntimeTerminalClose } from '../../shared/runtime-types'
import type { AgentTeamsTerminalApi } from './claude-agent-teams-types'

// Why: a team launch closes several placeholder panes at once, and Windows PTY
// teardown confirmation can outlast a single closeTerminal() call under that
// contention. Each attempt already waits out its own confirmation deadline, so
// retrying re-checks rather than adding an artificial delay.
const MAX_RESPAWN_CLOSE_ATTEMPTS = 3

export type CloseUntilConfirmedResult =
  | { confirmed: true }
  | { confirmed: false; close: RuntimeTerminalClose }

// Why: a handle that goes stale between attempts means the PTY did die, just
// not in time for the earlier attempt to see it confirmed.
export async function closeUntilConfirmed(
  handle: string,
  api: AgentTeamsTerminalApi
): Promise<CloseUntilConfirmedResult> {
  let lastClose: RuntimeTerminalClose | undefined
  for (let attempt = 0; attempt < MAX_RESPAWN_CLOSE_ATTEMPTS; attempt++) {
    try {
      const close = await api.closeTerminal(handle)
      if (close.ptyKilled) {
        return { confirmed: true }
      }
      lastClose = close
    } catch (error) {
      if (error instanceof Error && error.message === 'terminal_handle_stale') {
        return { confirmed: true }
      }
      throw error
    }
  }
  return { confirmed: false, close: lastClose! }
}
