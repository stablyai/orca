/**
 * Minting the durable operation ids mobile names its mutations with.
 *
 * Its own module because the create path mints one too, and reaching the session RPC module for it
 * would pull the native-chat write graph into `tasks/` for two functions that depend on nothing.
 */

import { createStructuredAgentSessionOperationId } from '../../../src/shared/structured-agent-session-mutation'

/** React Native has no guaranteed `crypto.randomUUID`; the fallback keeps the same
 *  32-hex entropy shape the durable id and fingerprint helpers validate. */
export function structuredSessionRandomUuid(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

export function structuredSessionOperationId(now: number = Date.now()): string {
  return createStructuredAgentSessionOperationId(structuredSessionRandomUuid, now)
}
