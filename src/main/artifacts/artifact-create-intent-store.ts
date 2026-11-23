import { createHash } from 'node:crypto'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'
import {
  ARTIFACT_MAX_CONTENT_BYTES,
  ARTIFACT_MAX_REQUEST_BYTES,
  artifactContentByteLength
} from '../../shared/artifacts/artifacts'
import { bestEffortFsyncDirectorySync } from '../../shared/secure-storage/secure-file'
import { bestEffortFsyncDirectory } from '../../shared/secure-storage/secure-file-async-write'
import {
  serializeArtifactFileChange,
  writeArtifactFileWhileCurrent
} from './artifact-guarded-secure-write'
import { getOrcaProfileDirectory } from '../orca-profiles/profile-storage-paths'
import type { ArtifactWriteBody } from './artifact-cloud-request'
import type { ArtifactShareScope } from './artifact-share-record-store'
import {
  artifactIntentRequestByteLength,
  MAX_ARTIFACT_CREATE_INTENT_BYTES,
  readIntent,
  readIntentKey,
  type ArtifactCreateIntent
} from './artifact-create-intent-file'

export { MAX_ARTIFACT_CREATE_INTENT_BYTES, type ArtifactCreateIntent }

export const MAX_PENDING_ARTIFACT_CREATES = 32

function intentDirectory(profileId: string, userDataPath: string): string {
  return join(getOrcaProfileDirectory(profileId, userDataPath), 'artifact-create-intents')
}

const waitingCreatesByFolder = new Map<string, number>()

async function persistedIntentCount(folder: string): Promise<number> {
  try {
    return (await readdir(folder)).filter((name) => name.endsWith('.json')).length
  } catch (error) {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      return 0
    }
    throw error
  }
}

async function removeTemporaryIntents(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (name.endsWith('.tmp')) {
      await rm(join(directory, name), { force: true })
    }
  }
}

function intentPath(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope
): string {
  const identity = JSON.stringify([
    sourceKey,
    scope.cloudUserId,
    scope.cloudProfileId,
    scope.cloudOrganizationId,
    scope.apiOrigin
  ])
  const fileName = `${createHash('sha256').update(identity).digest('hex')}.json`
  return join(intentDirectory(profileId, userDataPath), fileName)
}

function scopeMatches(left: ArtifactShareScope, right: ArtifactShareScope): boolean {
  return (
    left.cloudUserId === right.cloudUserId &&
    left.cloudProfileId === right.cloudProfileId &&
    left.cloudOrganizationId === right.cloudOrganizationId &&
    left.apiOrigin === right.apiOrigin
  )
}

async function intentExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      return false
    }
    throw error
  }
}

export async function getArtifactCreateIntent(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope
): Promise<ArtifactCreateIntent | null> {
  const path = intentPath(profileId, userDataPath, sourceKey, scope)
  if (!(await intentExists(path))) {
    return null
  }
  const intent = await readIntent(path)
  if (intent.sourceKey !== sourceKey || !scopeMatches(intent.scope, scope)) {
    throw new Error('Artifact create recovery record does not match its storage identity.')
  }
  return intent
}

/** The intent is on disk before this resolves, so a crash after the request can replay it.
 *  `assertCurrent` must still pass when it is published, or nothing is written. */
export async function getOrCreateArtifactCreateIntent(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope,
  idempotencyKey: string,
  body: ArtifactWriteBody,
  assertCurrent: () => void
): Promise<ArtifactCreateIntent> {
  if (artifactContentByteLength(body.content) > ARTIFACT_MAX_CONTENT_BYTES) {
    throw new Error('Artifact content exceeds the 10 MiB limit.')
  }
  if (artifactIntentRequestByteLength(sourceKey, body) > ARTIFACT_MAX_REQUEST_BYTES) {
    throw new Error('Artifact create recovery record exceeds the supported size.')
  }
  const folder = intentDirectory(profileId, userDataPath)
  // Waiting creates hold their bodies, so they count against the cap before they queue.
  const waiting = waitingCreatesByFolder.get(folder) ?? 0
  if (waiting >= MAX_PENDING_ARTIFACT_CREATES) {
    throw new Error(TOO_MANY_CREATES)
  }
  waitingCreatesByFolder.set(folder, waiting + 1)
  let released = false
  // A published intent counts as a file, so it stops counting as waiting.
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    const left = (waitingCreatesByFolder.get(folder) ?? 1) - 1
    if (left > 0) {
      waitingCreatesByFolder.set(folder, left)
    } else {
      waitingCreatesByFolder.delete(folder)
    }
  }
  try {
    const persisted = await persistedIntentCount(folder)
    // Read after the scan: a create that published meanwhile is in the files, not the waiters.
    const others = (waitingCreatesByFolder.get(folder) ?? 1) - 1
    if (others + persisted >= MAX_PENDING_ARTIFACT_CREATES) {
      throw new Error(TOO_MANY_CREATES)
    }
    // One create per profile at a time: the temp sweep and the pending cap read the whole folder.
    return await serializeArtifactFileChange(folder, () =>
      writeNewIntent(
        { profileId, userDataPath, sourceKey, scope, idempotencyKey, body, assertCurrent },
        release
      )
    )
  } finally {
    release()
  }
}

const TOO_MANY_CREATES =
  'Too many artifact creates are waiting for recovery. Retry an earlier share.'

type NewIntent = {
  profileId: string
  userDataPath: string
  sourceKey: string
  scope: ArtifactShareScope
  idempotencyKey: string
  body: ArtifactWriteBody
  assertCurrent: () => void
}

async function writeNewIntent(
  { profileId, userDataPath, sourceKey, scope, idempotencyKey, body, assertCurrent }: NewIntent,
  onPublished: () => void
): Promise<ArtifactCreateIntent> {
  assertCurrent()
  const existing = await getArtifactCreateIntent(profileId, userDataPath, sourceKey, scope)
  if (existing) {
    return existing
  }
  const directory = intentDirectory(profileId, userDataPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await removeTemporaryIntents(directory)
  const pendingCount = await persistedIntentCount(directory)
  if (pendingCount >= MAX_PENDING_ARTIFACT_CREATES) {
    throw new Error(TOO_MANY_CREATES)
  }
  const intent: ArtifactCreateIntent = {
    version: 1,
    sourceKey,
    scope,
    idempotencyKey,
    body
  }
  const serializedIntent = JSON.stringify(intent, null, 2)
  if (Buffer.byteLength(serializedIntent, 'utf8') > MAX_ARTIFACT_CREATE_INTENT_BYTES) {
    throw new Error('Artifact create recovery record exceeds the supported size.')
  }
  const path = intentPath(profileId, userDataPath, sourceKey, scope)
  await writeArtifactFileWhileCurrent(
    path,
    serializedIntent,
    true,
    assertCurrent,
    true,
    onPublished
  )
  return intent
}

export async function removeArtifactCreateIntent(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope,
  expectedIdempotencyKey: string
): Promise<void> {
  const path = intentPath(profileId, userDataPath, sourceKey, scope)
  if (!(await intentExists(path))) {
    return
  }
  let matches = true
  try {
    const known = (await readIntentKey(path)) ?? (await readIntent(path)).idempotencyKey
    matches = known === expectedIdempotencyKey
  } catch {
    // Unreadable intents cannot be replayed and may be discarded after completion; only this
    // single-instance app writes them, and its per-source queue orders create and removal.
  }
  if (matches) {
    await rm(path, { force: true })
    await bestEffortFsyncDirectory(intentDirectory(profileId, userDataPath))
  }
}

export function clearArtifactCreateIntents(profileId: string, userDataPath: string): void {
  const directory = intentDirectory(profileId, userDataPath)
  if (!existsSync(directory)) {
    return
  }
  for (const name of readdirSync(directory)) {
    if (name.endsWith('.json') || name.endsWith('.tmp')) {
      rmSync(join(directory, name), { force: true })
    }
  }
  bestEffortFsyncDirectorySync(directory)
}
