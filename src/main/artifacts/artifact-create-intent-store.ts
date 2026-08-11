import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureJsonFile } from '../../shared/secure-file'
import { getOrcaProfileDirectory } from '../orca-profiles/profile-storage-paths'
import type { ArtifactWriteBody } from './artifact-cloud-request'
import type { ArtifactShareScope } from './artifact-share-record-store'

export const MAX_PENDING_ARTIFACT_CREATES = 32

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
    typeof body.contentType === 'string' &&
    typeof body.fileName === 'string' &&
    (body.title === undefined || typeof body.title === 'string')
  )
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
  const existing = getArtifactCreateIntent(profileId, userDataPath, sourceKey, scope)
  if (existing) {
    return existing
  }
  const directory = intentDirectory(profileId, userDataPath)
  const pendingCount = existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith('.json')).length
    : 0
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
  writeSecureJsonFile(intentPath(profileId, userDataPath, sourceKey, scope), intent)
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
  if (readIntent(path).idempotencyKey === expectedIdempotencyKey) {
    rmSync(path, { force: true })
  }
}

export function clearArtifactCreateIntents(profileId: string, userDataPath: string): void {
  rmSync(intentDirectory(profileId, userDataPath), { force: true, recursive: true })
}
