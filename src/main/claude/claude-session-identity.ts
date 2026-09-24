import { createHash } from 'node:crypto'

/**
 * The provider session id a Claude structured session starts life with, before
 * any handle chain exists. Deterministic from the Orca session id, so a record
 * that has only been reserved still names its transcript — which is what lets a
 * reader recognise ownership of a session that has not yet been acquired.
 *
 * Lives apart from the launch resolver so callers that only need the identity
 * (ownership checks, history) do not pull in spawn resolution.
 */
export function claudeSessionIdForOrcaSession(sessionId: string): string {
  const bytes = createHash('sha256').update(`orca-claude:${sessionId}`).digest().subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
