import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/structured-agent-session-projection'

// Why two shapes: APNs nests Orca's fields under `orca` beside `aps`, while FCM
// carries them flat in `data` as strings. Both reach JS as the notification's
// `content.data`, so the reader accepts either and coerces the numeric fields.
export type OrcaPushPayload = {
  readonly kind?: 'alert' | 'dismiss'
  readonly hostFingerprint: string
  readonly notificationId?: string
  readonly notificationSeq?: number
  readonly notificationEpoch?: string
  readonly paneKey?: string
  readonly worktreeId?: string
  readonly executionHost?: string
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readSeq(value: unknown): number | undefined {
  const raw = typeof value === 'number' ? value : Number(readString(value))
  return Number.isFinite(raw) ? raw : undefined
}

function fallbackPaneKeyFromNotificationId(notificationId: string | undefined): string | undefined {
  if (!notificationId) {
    return undefined
  }
  if (notificationId.startsWith('agent:')) {
    const parts = notificationId.split(':')
    if (parts.length >= 4 && parts[2]) {
      try {
        const decoded = decodeURIComponent(parts[2]).trim()
        return decoded.length > 0 ? decoded : undefined
      } catch {
        return undefined
      }
    }
  }
  if (notificationId.startsWith('agent-attention:')) {
    const parts = notificationId.split(':')
    if (parts.length >= 3 && parts[2]) {
      try {
        const sessionId = decodeURIComponent(parts[2]).trim()
        return sessionId.length > 0
          ? structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
          : undefined
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

export function readOrcaPushPayload(data: unknown): OrcaPushPayload | null {
  if (!data || typeof data !== 'object') {
    return null
  }
  const nested = (data as { orca?: unknown }).orca
  const record = (nested && typeof nested === 'object' ? nested : data) as Record<string, unknown>
  // The fingerprint is what makes this a gateway push; locally scheduled data never has one.
  const hostFingerprint = readString(record.hostFingerprint)
  if (!hostFingerprint) {
    return null
  }
  const notificationId = readString(record.notificationId)
  const paneKey = readString(record.paneKey) ?? fallbackPaneKeyFromNotificationId(notificationId)
  return {
    hostFingerprint,
    ...(record.kind === 'dismiss' || record.kind === 'alert' ? { kind: record.kind } : {}),
    notificationId,
    notificationSeq: readSeq(record.notificationSeq),
    notificationEpoch: readString(record.notificationEpoch),
    paneKey,
    worktreeId: readString(record.worktreeId),
    executionHost: readString(record.executionHost)
  }
}
