import { createHash } from 'node:crypto'

/** A stable UUID (v4 layout) for the Claude conversation behind an Orca chat. */
export function claudeSessionIdForOrcaSession(
  sessionId: string,
  clearOperationId?: string
): string {
  const identity = clearOperationId
    ? `orca-claude:${sessionId}:context-clear:${clearOperationId}`
    : `orca-claude:${sessionId}`
  const bytes = createHash('sha256').update(identity).digest().subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
