import { open, readFile, stat } from 'node:fs/promises'
import {
  ARTIFACT_MAX_CONTENT_BYTES,
  ARTIFACT_MAX_REQUEST_BYTES,
  artifactContentByteLength,
  artifactWriteRequestByteLength
} from '../../shared/artifacts/artifacts'
import type { ArtifactWriteBody } from './artifact-cloud-request'
import type { ArtifactShareScope } from './artifact-share-record-store'

export const MAX_ARTIFACT_CREATE_INTENT_BYTES = ARTIFACT_MAX_REQUEST_BYTES + 128 * 1024

export type ArtifactCreateIntent = {
  version: 1
  sourceKey: string
  scope: ArtifactShareScope
  idempotencyKey: string
  body: ArtifactWriteBody
}

const INTENT_KEY_PREFIX_BYTES = 64 * 1024

// Intents are written with JSON.stringify(_, null, 2), so the key is one line ahead of the body.
const INTENT_KEY_LINE = /\n {2}"idempotencyKey": ("(?:[^"\\\n]|\\.)*")/

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

export function artifactIntentRequestByteLength(
  sourceKey: string,
  body: ArtifactWriteBody
): number {
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

export async function readIntent(path: string): Promise<ArtifactCreateIntent> {
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
  return intent as ArtifactCreateIntent
}

/** The key from the file's head, so removal never reads or parses a body up to 10 MiB. */
export async function readIntentKey(path: string): Promise<string | null> {
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(INTENT_KEY_PREFIX_BYTES)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    const literal = INTENT_KEY_LINE.exec(head.subarray(0, bytesRead).toString('utf8'))?.[1]
    const key: unknown = literal === undefined ? null : JSON.parse(literal)
    return typeof key === 'string' ? key : null
  } finally {
    await handle.close()
  }
}
