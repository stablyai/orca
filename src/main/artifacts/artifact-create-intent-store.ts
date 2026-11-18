import { createHash } from 'node:crypto'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'
import {
  ARTIFACT_MAX_CONTENT_BYTES,
  ARTIFACT_MAX_REQUEST_BYTES,
  artifactContentByteLength,
  artifactWriteRequestByteLength
} from '../../shared/artifacts/artifacts'
import {
  bestEffortFsyncDirectory,
  bestEffortFsyncDirectorySync
} from '../../shared/secure-storage/secure-file'
import {
  serializeArtifactFileChange,
  writeArtifactFileWhileCurrent
} from './artifact-guarded-secure-write'
import { getOrcaProfileDirectory } from '../orca-profiles/profile-storage-paths'
import type { ArtifactWriteBody } from './artifact-cloud-request'
import type { ArtifactShareScope } from './artifact-share-record-store'

export const MAX_PENDING_ARTIFACT_CREATES = 32
export const MAX_ARTIFACT_CREATE_INTENT_BYTES = ARTIFACT_MAX_REQUEST_BYTES + 128 * 1024

export type ArtifactCreateIntent = {
  version: 1
  sourceKey: string
  scope: ArtifactShareScope
  idempotencyKey: string
  body: ArtifactWriteBody
}

function intentDirectory(profileId: string, userDataPath: string): string {
  return join(getOrcaProfileDirectory(profileId, userDataPath), 'artifact-create-intents')
}

const waitingCreatesByFolder = new Map<string, number>()
// Idempotency key of each intent this process wrote or read, so removal need not re-read a body up to 10 MiB.
const idempotencyKeyByPath = new Map<string, string>()

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

function isWriteBody(value: unknown): value is ArtifactWriteBody {
  if (!value || typeof value !== 'object') {
    return false
  }
  const body = value as Partial<ArtifactWriteBody>
  return (
    typeof body.content === 'string' &&
    artifactContentByteLength(body.content) <= ARTIFACT_MAX_CONTENT_BYTES &&
    (body.contentType === 'text/html' || body.contentType === 'text/markdown') &&
    typeof body.fileName === 'string' &&
    (body.title === undefined || typeof body.title === 'string')
  )
}

function artifactIntentRequestByteLength(sourceKey: string, body: ArtifactWriteBody): number {
  return artifactWriteRequestByteLength({ sourceKey, ...body })
}

function isScope(value: unknown): value is ArtifactShareScope {
  if (!value || typeof value !== 'object') {
    return false
  }
  const scope = value as Partial<ArtifactShareScope>
  return [
    scope.cloudUserId,
    scope.cloudProfileId,
    scope.cloudOrganizationId,
    scope.apiOrigin
  ].every((field) => typeof field === 'string')
}

async function readIntent(path: string): Promise<ArtifactCreateIntent> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch (error) {
    throw new Error('Artifact create recovery record could not be read safely.', { cause: error })
  }
  if (size > MAX_ARTIFACT_CREATE_INTENT_BYTES) {
    throw new Error('Artifact create recovery record exceeds the supported size.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error('Artifact create recovery record could not be read safely.', { cause: error })
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Artifact create recovery record has an unsupported format.')
  }
  const intent = parsed as Partial<ArtifactCreateIntent>
  if (
    intent.version !== 1 ||
    typeof intent.sourceKey !== 'string' ||
    typeof intent.idempotencyKey !== 'string' ||
    !intent.idempotencyKey ||
    !isScope(intent.scope) ||
    !isWriteBody(intent.body)
  ) {
    throw new Error('Artifact create recovery record has an unsupported format.')
  }
  if (artifactIntentRequestByteLength(intent.sourceKey, intent.body) > ARTIFACT_MAX_REQUEST_BYTES) {
    throw new Error('Artifact create recovery record exceeds the supported size.')
  }
  idempotencyKeyByPath.set(path, intent.idempotencyKey)
  return intent as ArtifactCreateIntent
}

async function intentExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      idempotencyKeyByPath.delete(path)
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
  waitingCreatesByFolder.set(folder, (waitingCreatesByFolder.get(folder) ?? 0) + 1)
  try {
    const waiting = (waitingCreatesByFolder.get(folder) ?? 1) - 1
    if (waiting + (await persistedIntentCount(folder)) >= MAX_PENDING_ARTIFACT_CREATES) {
      throw new Error('Too many artifact creates are waiting for recovery. Retry an earlier share.')
    }
    // One create per profile at a time: the temp sweep and the pending cap read the whole folder.
    return await serializeArtifactFileChange(folder, () =>
      writeNewIntent(profileId, userDataPath, sourceKey, scope, idempotencyKey, body, assertCurrent)
    )
  } finally {
    const left = (waitingCreatesByFolder.get(folder) ?? 1) - 1
    if (left > 0) {
      waitingCreatesByFolder.set(folder, left)
    } else {
      waitingCreatesByFolder.delete(folder)
    }
  }
}

async function writeNewIntent(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope,
  idempotencyKey: string,
  body: ArtifactWriteBody,
  assertCurrent: () => void
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
    throw new Error('Too many artifact creates are waiting for recovery. Retry an earlier share.')
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
  await writeArtifactFileWhileCurrent(path, serializedIntent, true, assertCurrent, true, () =>
    idempotencyKeyByPath.set(path, idempotencyKey)
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
    const known = idempotencyKeyByPath.get(path) ?? (await readIntent(path)).idempotencyKey
    matches = known === expectedIdempotencyKey
  } catch {
    // Unreadable intents cannot be replayed and may be discarded after completion.
  }
  if (matches) {
    await rm(path, { force: true })
    idempotencyKeyByPath.delete(path)
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
      idempotencyKeyByPath.delete(join(directory, name))
    }
  }
  bestEffortFsyncDirectorySync(directory)
}
