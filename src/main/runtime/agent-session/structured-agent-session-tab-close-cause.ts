import type { RuntimeSessionTabCloseReason } from '../../../shared/runtime-session-contracts'
import type { StructuredAgentSessionCloseCause } from '../../native-chat/agent-session-wire/structured-agent-session-host-lifetime'

/** Missing reason means an older client's user close; lifecycle echoes do not represent user intent. */
export function structuredAgentSessionTabCloseCause(
  reason: RuntimeSessionTabCloseReason | undefined
): StructuredAgentSessionCloseCause {
  switch (reason) {
    case undefined:
    case 'user':
      return 'user-close'
    case 'pty-exit':
    case 'cleanup':
      return 'evict'
  }
}
