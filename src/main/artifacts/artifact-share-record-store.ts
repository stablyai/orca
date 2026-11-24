import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'
import { writeDurableSecureJsonFile } from '../../shared/secure-storage/secure-file'
import {
  serializeArtifactFileChange,
  writeArtifactFileWhileCurrent
} from './artifact-guarded-secure-write'
import { getOrcaProfileDirectory } from '../orca-profiles/profile-storage-paths'
import {
  pruneRecords,
  type ArtifactShareRecord,
  type ArtifactShareScope
} from './artifact-share-record-retention'
import {
  artifactSharesPrunedOnRead,
  parseArtifactShareRecordFile,
  type ArtifactShareRecordFile,
  type PreserveExpired
} from './artifact-share-record-file'

export type { ArtifactShareScope } from './artifact-share-record-retention'

function recordPath(profileId: string, userDataPath: string): string {
  return join(getOrcaProfileDirectory(profileId, userDataPath), 'artifact-shares.json')
}

function readRecords(
  profileId: string,
  userDataPath: string,
  preserveExpired?: PreserveExpired,
  pruneExpired = true
): ArtifactShareRecordFile {
  let text: string | undefined
  try {
    text = readFileSync(recordPath(profileId, userDataPath), 'utf8')
  } catch (error) {
    if (errnoCodeOrUnknown(error) !== 'ENOENT') {
      throw new Error('Artifact share records could not be read safely.', { cause: error })
    }
  }
  return parseArtifactShareRecordFile(text, preserveExpired, pruneExpired)
}

async function readRecordsAsync(
  profileId: string,
  userDataPath: string,
  preserveExpired?: PreserveExpired
): Promise<ArtifactShareRecordFile> {
  let text: string | undefined
  try {
    text = await readFile(recordPath(profileId, userDataPath), 'utf8')
  } catch (error) {
    if (errnoCodeOrUnknown(error) !== 'ENOENT') {
      throw new Error('Artifact share records could not be read safely.', { cause: error })
    }
  }
  return parseArtifactShareRecordFile(text, preserveExpired, true)
}

const prunesQueued = new Set<string>()

/** Lookups never write: the rows one dropped are written by a single queued change, held to the
 *  lifecycle it saw so a sign-out's clear is never undone. */
function persistPrune(profileId: string, userDataPath: string): void {
  const path = recordPath(profileId, userDataPath)
  if (prunesQueued.has(path)) {
    return
  }
  const lifecycle = captureArtifactShareLifecycle(profileId, userDataPath)
  prunesQueued.add(path)
  const assertCurrent = (): void => {
    if (!isArtifactShareLifecycleCurrent(profileId, userDataPath, lifecycle)) {
      throw new Error('Artifact share records were cleared before the prune was written.')
    }
  }
  void changeRecords(profileId, userDataPath, assertCurrent, { durable: false }, () => false)
    // A later read or change prunes again.
    .catch(() => undefined)
    .finally(() => prunesQueued.delete(path))
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

export async function getArtifactShareRecord(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope
): Promise<ArtifactShareRecord | null> {
  const records = await readRecordsAsync(profileId, userDataPath)
  if (artifactSharesPrunedOnRead.has(records)) {
    persistPrune(profileId, userDataPath)
  }
  const record = records.shares[sourceKey]
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
    preserveExpired?: PreserveExpired
  },
  change: (records: ArtifactShareRecordFile) => boolean
): Promise<void> {
  const path = recordPath(profileId, userDataPath)
  return serializeArtifactFileChange(path, async () => {
    assertCurrent()
    const records = await readRecordsAsync(profileId, userDataPath, options.preserveExpired)
    if (change(records) || artifactSharesPrunedOnRead.has(records)) {
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
  // A recycled inode must not let an in-flight fence keep the lifecycle this clear ends.
  lifecycleByPath.delete(recordPath(profileId, userDataPath))
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
