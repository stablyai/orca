// Why two shapes: APNs nests Orca's fields under `orca` beside `aps`, while FCM
// carries them flat in `data` as strings. Both reach JS as the notification's
// `content.data`, so the reader accepts either and coerces the numeric fields.
export type OrcaPushPayload = {
  readonly hostFingerprint: string
  readonly notificationId?: string
  readonly notificationSeq?: number
  readonly notificationEpoch?: string
  readonly worktreeId?: string
  readonly source?: string
  // Present only on a gateway summary standing in for N events; see the coalescing
  // window in docs/reference/mobile-push-contract.md.
  readonly coalescedCount?: number
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readSeq(value: unknown): number | undefined {
  const raw = typeof value === 'number' ? value : Number(readString(value))
  return Number.isFinite(raw) ? raw : undefined
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
  return {
    hostFingerprint,
    notificationId: readString(record.notificationId),
    notificationSeq: readSeq(record.notificationSeq),
    notificationEpoch: readString(record.notificationEpoch),
    worktreeId: readString(record.worktreeId),
    source: readString(record.source),
    coalescedCount: readSeq(record.coalescedCount)
  }
}
