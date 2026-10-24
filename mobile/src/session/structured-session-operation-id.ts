/**
 * Minting the durable operation ids mobile names its mutations with.
 *
 * Its own module because the create path mints one too, and reaching the session RPC module for it
 * would pull the native-chat write graph into `tasks/` for a function that depends on nothing.
 */

import { createStructuredAgentSessionOperationId } from '../../../src/shared/structured-agent-session-mutation'
import { randomV4Uuid } from '../platform/random-v4-uuid'

export function structuredSessionOperationId(now: number = Date.now()): string {
  return createStructuredAgentSessionOperationId(randomV4Uuid, now)
}
