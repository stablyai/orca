import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import {
  ARTIFACT_MAX_CONTENT_BYTES,
  ARTIFACT_MAX_REQUEST_BYTES,
  artifactContentByteLength,
  artifactWriteRequestByteLength
} from '../../shared/artifacts'
import {
  bestEffortFsyncDirectorySync,
  fsyncFileSync,
  hardenSecurePath
} from '../../shared/secure-file'
import { getOrcaProfileDirectory } from '../orca-profiles/profile-storage-paths'
import type { ArtifactWriteBody } from './artifact-cloud-request'
import type { ArtifactShareScope } from './artifact-share-record-store'

export const MAX_PENDING_ARTIFACT_CREATES = 32
export const MAX_ARTIFACT_CREATE_INTENT_BYTES = ARTIFACT_MAX_REQUEST_BYTES + 128 * 1024

const MAX_HARDENED_INTENT_DIRECTORIES = 64
const hardenedIntentDirectories = new Set<string>()

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

function ensureIntentDirectory(profileId: string, userDataPath: string): string {
  const directory = intentDirectory(profileId, userDataPath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!hardenedIntentDirectories.has(directory)) {
    hardenSecurePath(directory, {
      isDirectory: true,
      platform: process.platform,
      sync: true
    })
    if (hardenedIntentDirectories.size >= MAX_HARDENED_INTENT_DIRECTORIES) {
      const oldest = hardenedIntentDirectories.values().next().value
      if (oldest !== undefined) {
        hardenedIntentDirectories.delete(oldest)
      }
    }
    hardenedIntentDirectories.add(directory)
  }
  return directory
}

function removeTemporaryIntents(directory: string): void {
  for (const name of readdirSync(directory)) {
    if (name.endsWith('.tmp')) {
      rmSync(join(directory, name), { force: true })
    }
  }
}

function writeIntent(path: string, directory: string, serializedIntent: string): void {
  // Child files inherit the once-hardened directory ACL, avoiding per-create PowerShell launches.
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(temporaryPath, serializedIntent, {
      encoding: 'utf8',
      mode: 0o600
    })
    fsyncFileSync(temporaryPath)
    renameSync(temporaryPath, path)
    bestEffortFsyncDirectorySync(directory)
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
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

function readIntent(path: string): ArtifactCreateIntent {
  let size: number
  try {
    size = statSync(path).size
  } catch (error) {
    throw new Error('Artifact create recovery record could not be read safely.', { cause: error })
  }
  if (size > MAX_ARTIFACT_CREATE_INTENT_BYTES) {
    throw new Error('Artifact create recovery record exceeds the supported size.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
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
  return intent as ArtifactCreateIntent
}

export function getArtifactCreateIntent(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope
): ArtifactCreateIntent | null {
  const path = intentPath(profileId, userDataPath, sourceKey, scope)
  if (!existsSync(path)) {
    return null
  }
  const intent = readIntent(path)
  if (intent.sourceKey !== sourceKey || !scopeMatches(intent.scope, scope)) {
    throw new Error('Artifact create recovery record does not match its storage identity.')
  }
  return intent
}

export function getOrCreateArtifactCreateIntent(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope,
  idempotencyKey: string,
  body: ArtifactWriteBody
): ArtifactCreateIntent {
  if (artifactContentByteLength(body.content) > ARTIFACT_MAX_CONTENT_BYTES) {
    throw new Error('Artifact content exceeds the 10 MiB limit.')
  }
  if (artifactIntentRequestByteLength(sourceKey, body) > ARTIFACT_MAX_REQUEST_BYTES) {
    throw new Error('Artifact create recovery record exceeds the supported size.')
  }
  const existing = getArtifactCreateIntent(profileId, userDataPath, sourceKey, scope)
  if (existing) {
    return existing
  }
  const directory = ensureIntentDirectory(profileId, userDataPath)
  removeTemporaryIntents(directory)
  const pendingCount = readdirSync(directory).filter((name) => name.endsWith('.json')).length
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
  writeIntent(intentPath(profileId, userDataPath, sourceKey, scope), directory, serializedIntent)
  return intent
}

export function removeArtifactCreateIntent(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope,
  expectedIdempotencyKey: string
): void {
  const path = intentPath(profileId, userDataPath, sourceKey, scope)
  if (!existsSync(path)) {
    return
  }
  let matches = true
  try {
    matches = readIntent(path).idempotencyKey === expectedIdempotencyKey
  } catch {
    // An unreadable record cannot be replayed, so a completed mutation may discard it safely.
  }
  if (matches) {
    rmSync(path, { force: true })
    bestEffortFsyncDirectorySync(intentDirectory(profileId, userDataPath))
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
