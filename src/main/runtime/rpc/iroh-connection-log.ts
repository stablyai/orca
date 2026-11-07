/** Compact remote id + path kind for accept logs (no secrets). */
import { createHash } from 'node:crypto'

/** Hash the bearer-token client ID into a stable log label without exposing it. */
export function clientIdLogLabel(clientId: string | null): string {
  if (clientId === null) {
    return 'unauth'
  }
  return createHash('sha256').update(clientId).digest('hex').slice(0, 12)
}

/** Return a short public endpoint ID, tolerating unavailable native diagnostics. */
export function remoteIdPrefix(connection: { remoteId?: () => { toString(): string } }): string {
  try {
    const id = connection.remoteId?.()?.toString() ?? ''
    return id.length >= 8 ? id.slice(0, 8) : id || 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Describe the selected QUIC path, or unknown when native path inspection fails. */
export function connectionPathKind(connection: {
  paths?: () => { isSelected?: boolean; isRelay?: boolean; isIp?: boolean }[]
}): string {
  try {
    const paths = connection.paths?.() ?? []
    const selected = paths.find((path) => path.isSelected) ?? paths[0]
    if (!selected) {
      return 'unknown'
    }
    if (selected.isRelay) {
      return 'relay'
    }
    if (selected.isIp) {
      return 'direct'
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
