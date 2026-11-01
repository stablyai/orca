// Keep id generation dependency-free so create/tasks callers do not pull in the native-chat write graph.

import { createStructuredAgentSessionOperationId } from '../../../src/shared/structured-agent-session-mutation'
import { randomV4Uuid } from '../platform/random-v4-uuid'

export function structuredSessionOperationId(now: number = Date.now()): string {
  return createStructuredAgentSessionOperationId(randomV4Uuid, now)
}
