import type { ArtifactWriteRequest } from '../../shared/artifacts'
import { OrcaCloudRequestError } from '../orca-profiles/profile-cloud-client'

export type ArtifactFetchOptions = {
  token?: string
  method?: string
  headers?: Record<string, string>
  signal?: AbortSignal
  body?: string
}

/** Shared first-party fetch policy for artifact metadata and public content. */
export function artifactFetch(url: string, options: ArtifactFetchOptions = {}): Promise<Response> {
  return fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers
    },
    body: options.body,
    redirect: 'error',
    signal: options.signal ?? AbortSignal.timeout(20_000)
  })
}

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

export async function artifactRequest<T>(
  apiUrl: string,
  token: string,
  path: string,
  options: { method?: string; body?: unknown; editToken?: string; idempotencyKey?: string } = {}
): Promise<T> {
  const response = await artifactFetch(`${apiUrl}/v1/artifacts${path}`, {
    token,
    method: options.method ?? 'GET',
    headers: {
      ...(options.editToken ? { 'x-orca-edit-token': options.editToken } : {}),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string
      code?: string
    } | null
    throw new OrcaCloudRequestError(response.status, body?.error ?? body?.code)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

export async function deleteArtifactRequest(
  apiUrl: string,
  token: string,
  path: string,
  editToken?: string
): Promise<void> {
  try {
    await artifactRequest<void>(apiUrl, token, path, {
      method: 'DELETE',
      ...(editToken ? { editToken } : {})
    })
  } catch (error) {
    if (
      !(error instanceof OrcaCloudRequestError) ||
      error.statusCode !== 404 ||
      error.errorCode !== 'artifact_not_found'
    ) {
      throw error
    }
  }
}
