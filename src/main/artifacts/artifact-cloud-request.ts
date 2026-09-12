import type { ArtifactWriteRequest } from '../../shared/artifacts'
import { OrcaCloudRequestError } from '../orca-profiles/profile-cloud-client'

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
  const response = await fetch(`${apiUrl}/v1/artifacts${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.editToken ? { 'x-orca-edit-token': options.editToken } : {}),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { code?: string } | null
    throw new OrcaCloudRequestError(response.status, body?.code)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}
