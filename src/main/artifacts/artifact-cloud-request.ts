import {
  ARTIFACT_CLOUD_REQUEST_TIMEOUT_MS,
  ARTIFACT_RATE_LIMIT_MAX_RETRY_DELAY_SECONDS,
  type ArtifactWriteRequest
} from '../../shared/artifacts/artifacts'
import { OrcaCloudRequestError } from '../orca-profiles/cloud-auth/profile-cloud-client'
import { readArtifactRateLimitResponse } from './artifact-cloud-rate-limit'
import type { ArtifactRateLimitReplay } from './artifact-cloud-auth-context'

export type ArtifactWriteBody = {
  content: string
  contentType: ArtifactWriteRequest['contentType']
  fileName: string
  title?: string
}

export function artifactWriteBody(request: ArtifactWriteRequest): ArtifactWriteBody {
  return {
    content: request.content,
    contentType: request.contentType,
    fileName: request.fileName,
    ...(request.title ? { title: request.title } : {})
  }
}

type ArtifactRequestOptions = {
  method?: string
  body?: unknown
  editToken?: string
  idempotencyKey?: string
  /** The operation's single 429 replay; without it a 429 never replays. */
  rateLimitReplay?: ArtifactRateLimitReplay
}

function sendArtifactRequest(
  apiUrl: string,
  token: string,
  path: string,
  options: ArtifactRequestOptions
): Promise<Response> {
  return fetch(`${apiUrl}/v1/artifacts${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.editToken ? { 'x-orca-edit-token': options.editToken } : {}),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(ARTIFACT_CLOUD_REQUEST_TIMEOUT_MS)
  })
}

// A POST without an Idempotency-Key could create a second artifact if the first one landed.
function canReplay(options: ArtifactRequestOptions): boolean {
  return (
    options.rateLimitReplay !== undefined &&
    ((options.method ?? 'GET') !== 'POST' || Boolean(options.idempotencyKey))
  )
}

export async function artifactRequest<T>(
  apiUrl: string,
  token: string,
  path: string,
  options: ArtifactRequestOptions = {}
): Promise<T> {
  let response = await sendArtifactRequest(apiUrl, token, path, options)
  if (response.status === 429) {
    const limited = await readArtifactRateLimitResponse(response)
    const delay = limited.retryAfterSeconds
    // One replay with the same Idempotency-Key for a short wait, per operation; never loop on 429.
    if (
      delay === null ||
      delay > ARTIFACT_RATE_LIMIT_MAX_RETRY_DELAY_SECONDS ||
      !canReplay(options) ||
      !options.rateLimitReplay?.claim()
    ) {
      throw limited.error
    }
    await new Promise((resolve) => setTimeout(resolve, delay * 1000))
    // A sign-out or account switch during the wait must not create, update or delete under the old token.
    options.rateLimitReplay?.assertCanReplay()
    response = await sendArtifactRequest(apiUrl, token, path, options)
    if (response.status === 429) {
      throw (await readArtifactRateLimitResponse(response)).error
    }
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { code?: string } | null
    throw new OrcaCloudRequestError(response.status, body?.code)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}
