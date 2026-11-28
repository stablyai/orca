import type { RuntimeSessionTabCloseReason } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { StructuredAgentSessionClose } from '../../../native-chat/agent-session-wire/termination/structured-agent-session-host-lifetime'

/** Missing reason means an older client's user close; lifecycle echoes do not represent user intent. */
export function structuredAgentSessionTabClose(
  reason: RuntimeSessionTabCloseReason | undefined,
  closedBy: string
): StructuredAgentSessionClose {
  switch (reason) {
    case undefined:
    case 'user':
      return { closedBy }
    case 'pty-exit':
    case 'cleanup':
      return 'evict'
  }
}
