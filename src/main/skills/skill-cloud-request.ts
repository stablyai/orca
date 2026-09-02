import { resolveArtifactCloudApiUrl } from '../artifacts/artifact-cloud-config'
import { createSkillCloudDeadline } from './skill-cloud-deadline'

export class SkillCloudRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export async function skillCloudRequest<T>(input: {
  apiUrl?: string
  authToken?: string
  path: string
  method?: 'DELETE' | 'GET' | 'POST' | 'PUT'
  body?: unknown
  signal?: AbortSignal
  idempotencyKey?: string
  fetcher?: typeof fetch
  timeoutMs?: number
}): Promise<T> {
  const apiUrl = resolveArtifactCloudApiUrl(input.apiUrl)
  const url = new URL(input.path, `${apiUrl}/`)
  if (url.origin !== apiUrl || !url.pathname.startsWith('/v1/')) {
    throw new Error('skill-cloud-request-path-invalid')
  }
  const deadline = createSkillCloudDeadline({
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    timeoutMessage: 'skill-cloud-request-timeout'
  })
  try {
    const response = await (input.fetcher ?? fetch)(url, {
      method: input.method ?? 'GET',
      headers: {
        ...(input.authToken ? { authorization: `Bearer ${input.authToken}` } : {}),
        accept: 'application/json',
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {})
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: deadline.signal,
      redirect: 'error'
    })
    if (response.status === 204) {
      return undefined as T
    }
    const value: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const error = value as { code?: unknown; message?: unknown } | null
      throw new SkillCloudRequestError(
        response.status,
        typeof error?.code === 'string' ? error.code : 'skill_cloud_request_failed',
        typeof error?.message === 'string' ? error.message : 'The skill Cloud request failed.'
      )
    }
    return value as T
  } finally {
    deadline.cleanup()
  }
}
