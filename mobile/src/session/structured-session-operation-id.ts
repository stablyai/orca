/**
 * Minting the durable operation ids mobile names its mutations with.
 *
 * Its own module because the create path mints one too, and reaching the session RPC module for it
 * would pull the native-chat write graph into `tasks/` for two functions that depend on nothing.
 */

import { createStructuredAgentSessionOperationId } from '../../../src/shared/structured-agent-session-mutation'

/** React Native has no guaranteed `crypto.randomUUID`; the fallback is a v4 UUID too, because a
 *  pane key's leaf must be one and the durable id helpers strip the dashes. */
export function structuredSessionRandomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16))
  hex[12] = '4'
  hex[16] = '89ab'[Math.floor(Math.random() * 4)]!
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

export function structuredSessionOperationId(now: number = Date.now()): string {
  return createStructuredAgentSessionOperationId(structuredSessionRandomUuid, now)
}
