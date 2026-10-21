import type { RuntimeSessionTabCloseReason } from '../../shared/runtime-types'
import type { StructuredAgentSessionCloseCause } from '../native-chat/agent-session-wire/structured-agent-session-host-lifetime'

/** Who a chat's `session.tabs.close` speaks for. A reasonless close is an older client's user
 *  close; a lifecycle echo is not the user's. */
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
