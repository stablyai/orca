import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableSecureJsonFile } from '../../shared/secure-storage/secure-file'
import {
  serializeArtifactFileChange,
  writeArtifactFileWhileCurrent
} from './artifact-guarded-secure-write'
import { getOrcaProfileDirectory } from '../orca-profiles/profile-storage-paths'

export type ArtifactShareScope = {
  cloudUserId: string
  cloudProfileId: string
  cloudOrganizationId: string
  apiOrigin: string
}

type ArtifactShareRecord = Omit<ArtifactShareScope, 'cloudOrganizationId'> & {
  cloudOrganizationId?: string
  slug: string
  editToken: string
  shareUrl: string
  expiresAt?: string
  savedAt?: number
}

type ArtifactShareRecordFile = {
  version: 2
  lifecycleGeneration: number
  lifecycleNonce: string
  shares: Record<string, ArtifactShareRecord>
}

type ParsedArtifactShareRecordFile = {
  version?: unknown
  lifecycleGeneration?: unknown
  lifecycleNonce?: unknown
  shares?: unknown
}

const MAX_ARTIFACT_SHARE_RECORDS = 10_000

function recordPath(profileId: string, userDataPath: string): string {
  return join(getOrcaProfileDirectory(profileId, userDataPath), 'artifact-shares.json')
}

function isRecord(value: unknown): value is ArtifactShareRecord {
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

function pruneRecords(
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

function readRecords(
  profileId: string,
  userDataPath: string,
  preserveExpired?: { sourceKey: string; slug: string; editToken: string },
  pruneExpired = true
): ArtifactShareRecordFile {
  const path = recordPath(profileId, userDataPath)
  if (!existsSync(path)) {
    return { version: 2, lifecycleGeneration: 0, lifecycleNonce: '', shares: {} }
  }
  let parsed: ParsedArtifactShareRecordFile
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as ParsedArtifactShareRecordFile
  } catch (error) {
    throw new Error('Artifact share records could not be read safely.', { cause: error })
  }
  if (parsed.version === 1) {
    return { version: 2, lifecycleGeneration: 0, lifecycleNonce: '', shares: {} }
  }
  if (
    parsed.version !== 2 ||
    !parsed.shares ||
    typeof parsed.shares !== 'object' ||
    Array.isArray(parsed.shares)
  ) {
    throw new Error('Artifact share records have an unsupported format.')
  }
  const shareEntries = Object.entries(parsed.shares as Record<string, unknown>)
  const validShares = Object.fromEntries(
    shareEntries.filter((entry): entry is [string, ArtifactShareRecord] => isRecord(entry[1]))
  )
  const pruned = pruneExpired
    ? pruneRecords(validShares, Date.now(), preserveExpired)
    : { shares: validShares, changed: false }
  const records: ArtifactShareRecordFile = {
    version: 2,
    lifecycleGeneration:
      Number.isSafeInteger(parsed.lifecycleGeneration) && Number(parsed.lifecycleGeneration) >= 0
        ? Number(parsed.lifecycleGeneration)
        : 0,
    lifecycleNonce: typeof parsed.lifecycleNonce === 'string' ? parsed.lifecycleNonce : '',
    shares: pruned.shares
  }
  // Readers never write: a change persists the pruned rows in its own serialized write.
  return records
}

function matchesScope(record: ArtifactShareRecord, scope: ArtifactShareScope): boolean {
  return (
    matchesScopeIdentity(record, scope) &&
    (record.cloudOrganizationId === undefined ||
      record.cloudOrganizationId === scope.cloudOrganizationId)
  )
}

function matchesScopeIdentity(record: ArtifactShareRecord, scope: ArtifactShareScope): boolean {
  return (
    record.cloudUserId === scope.cloudUserId &&
    record.cloudProfileId === scope.cloudProfileId &&
    record.apiOrigin === scope.apiOrigin
  )
}

export function getArtifactShareRecord(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope
): ArtifactShareRecord | null {
  const record = readRecords(profileId, userDataPath).shares[sourceKey]
  return record && matchesScope(record, scope) ? record : null
}

/** Read, change and write the record file one change at a time. `assertCurrent` holds the
 *  change to the account and record lifecycle it started under, before it reads and as it
 *  publishes, so a sign-out's clear is never undone by a change queued before it. */
function changeRecords(
  profileId: string,
  userDataPath: string,
  assertCurrent: () => void,
  options: {
    durable: boolean
    preserveExpired?: { sourceKey: string; slug: string; editToken: string }
  },
  change: (records: ArtifactShareRecordFile) => boolean
): Promise<void> {
  const path = recordPath(profileId, userDataPath)
  return serializeArtifactFileChange(path, async () => {
    assertCurrent()
    const records = readRecords(profileId, userDataPath, options.preserveExpired)
    if (change(records)) {
      const contents = JSON.stringify(records, null, 2)
      await writeArtifactFileWhileCurrent(path, contents, options.durable, assertCurrent, false)
    }
  })
}

export function saveArtifactShareRecord(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  record: ArtifactShareRecord,
  assertCurrent: () => void
): Promise<void> {
  return changeRecords(profileId, userDataPath, assertCurrent, { durable: true }, (records) => {
    records.shares[sourceKey] = { ...record, savedAt: Date.now() }
    records.shares = pruneRecords(records.shares, Date.now()).shares
    return true
  })
}

export function refreshArtifactShareRecordExpiration(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope,
  expected: { slug: string; editToken: string },
  expiresAt: string,
  assertCurrent: () => void
): Promise<void> {
  const preserveExpired = { sourceKey, ...expected }
  return changeRecords(
    profileId,
    userDataPath,
    assertCurrent,
    { durable: false, preserveExpired },
    (records) => {
      const current = records.shares[sourceKey]
      if (
        !current ||
        !matchesScope(current, scope) ||
        current.slug !== expected.slug ||
        current.editToken !== expected.editToken
      ) {
        return false
      }
      records.shares[sourceKey] = {
        ...current,
        cloudOrganizationId: scope.cloudOrganizationId,
        expiresAt,
        savedAt: Date.now()
      }
      return true
    }
  )
}

export function removeArtifactShareRecords(
  profileId: string,
  userDataPath: string,
  scope: ArtifactShareScope,
  match: { sourceKey?: string; slug?: string },
  assertCurrent: () => void
): Promise<void> {
  return changeRecords(profileId, userDataPath, assertCurrent, { durable: true }, (records) => {
    for (const [sourceKey, record] of Object.entries(records.shares)) {
      if (
        matchesScope(record, scope) &&
        (match.slug === record.slug || (match.slug === undefined && match.sourceKey === sourceKey))
      ) {
        delete records.shares[sourceKey]
      }
    }
    return true
  })
}

export function clearArtifactShareRecords(profileId: string, userDataPath: string): void {
  let lifecycleGeneration = 0
  try {
    lifecycleGeneration = readRecords(profileId, userDataPath, undefined, false).lifecycleGeneration
  } catch {
    // Clearing must recover sign-out from an unreadable token index.
  }
  writeDurableSecureJsonFile(recordPath(profileId, userDataPath), {
    version: 2,
    lifecycleGeneration: lifecycleGeneration + 1,
    lifecycleNonce: randomUUID(),
    shares: {}
  })
}

const lifecycleByPath = new Map<string, { stamp: string; lifecycle: string }>()

/** Every write replaces the file (new inode), so its stat stamp names one lifecycle: account checks
 *  read the whole index only when the file changed. */
export function captureArtifactShareLifecycle(profileId: string, userDataPath: string): string {
  const path = recordPath(profileId, userDataPath)
  let stamp = 'missing'
  try {
    const stat = statSync(path, { bigint: true })
    stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  } catch {
    // A missing or unreadable file goes through the full read, which reports it as before.
  }
  const cached = lifecycleByPath.get(path)
  if (cached?.stamp === stamp) {
    return cached.lifecycle
  }
  const records = readRecords(profileId, userDataPath, undefined, false)
  const lifecycle = `${records.lifecycleGeneration}:${records.lifecycleNonce}`
  lifecycleByPath.set(path, { stamp, lifecycle })
  return lifecycle
}

export function isArtifactShareLifecycleCurrent(
  profileId: string,
  userDataPath: string,
  lifecycle: string
): boolean {
  return captureArtifactShareLifecycle(profileId, userDataPath) === lifecycle
}
