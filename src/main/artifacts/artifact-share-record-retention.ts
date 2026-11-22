// Which saved share rows are valid, and which the index keeps: unexpired rows, newest first, up to its cap.

export type ArtifactShareScope = {
  cloudUserId: string
  cloudProfileId: string
  cloudOrganizationId: string
  apiOrigin: string
}

export type ArtifactShareRecord = Omit<ArtifactShareScope, 'cloudOrganizationId'> & {
  cloudOrganizationId?: string
  slug: string
  editToken: string
  shareUrl: string
  expiresAt?: string
  savedAt?: number
}

const MAX_ARTIFACT_SHARE_RECORDS = 10_000

export function isArtifactShareRecord(value: unknown): value is ArtifactShareRecord {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Partial<ArtifactShareRecord>
  const requiredFieldsValid = [
    record.slug,
    record.editToken,
    record.shareUrl,
    record.cloudUserId,
    record.cloudProfileId,
    record.apiOrigin
  ].every((field) => typeof field === 'string' && field.length > 0)
  const expiresAtValid =
    record.expiresAt === undefined ||
    (typeof record.expiresAt === 'string' && Number.isFinite(Date.parse(record.expiresAt)))
  const savedAtValid =
    record.savedAt === undefined ||
    (typeof record.savedAt === 'number' &&
      Number.isSafeInteger(record.savedAt) &&
      record.savedAt >= 0)
  return requiredFieldsValid && expiresAtValid && savedAtValid
}

function compareRecordsNewestFirst(
  [sourceKeyA, recordA]: [string, ArtifactShareRecord],
  [sourceKeyB, recordB]: [string, ArtifactShareRecord]
): number {
  const savedAtDifference = (recordB.savedAt ?? -1) - (recordA.savedAt ?? -1)
  if (savedAtDifference !== 0) {
    return savedAtDifference
  }
  return sourceKeyA < sourceKeyB ? -1 : sourceKeyA > sourceKeyB ? 1 : 0
}

export function pruneRecords(
  shares: Record<string, ArtifactShareRecord>,
  now: number,
  preserveExpired?: { sourceKey: string; slug: string; editToken: string }
): { shares: Record<string, ArtifactShareRecord>; changed: boolean } {
  const currentEntries = Object.entries(shares)
  const unexpired = currentEntries.filter(
    ([sourceKey, record]) =>
      (preserveExpired?.sourceKey === sourceKey &&
        preserveExpired.slug === record.slug &&
        preserveExpired.editToken === record.editToken) ||
      record.expiresAt === undefined ||
      Date.parse(record.expiresAt) > now
  )
  const retained =
    unexpired.length > MAX_ARTIFACT_SHARE_RECORDS
      ? unexpired.sort(compareRecordsNewestFirst).slice(0, MAX_ARTIFACT_SHARE_RECORDS)
      : unexpired
  return {
    shares: retained.length === currentEntries.length ? shares : Object.fromEntries(retained),
    changed: retained.length !== currentEntries.length
  }
}
