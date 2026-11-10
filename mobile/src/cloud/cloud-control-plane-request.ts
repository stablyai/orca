import { z } from 'zod'

// One HTTPS call to the Orca Cloud control plane with a fresh device-signed token.

export class CloudRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly reason?: string
  ) {
    super(reason ? `${code}:${reason}` : code)
    this.name = 'CloudRequestError'
  }
}

export type CloudControlPlane = {
  baseUrl: string
  token: () => string
  fetch?: typeof fetch
}

const ErrorBodySchema = z.object({ error: z.string(), reason: z.string().optional() })

export async function cloudRequest<T>(
  plane: CloudControlPlane,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  schema: z.ZodType<T>,
  init: {
    body?: unknown
    timeoutMs?: number
    signal?: AbortSignal
    headers?: Record<string, string>
  } = {}
): Promise<T> {
  // Hermes lacks AbortSignal.timeout/any, so the deadline is a plain controller.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000)
  const onAbort = () => controller.abort()
  init.signal?.addEventListener('abort', onAbort)
  const signal = controller.signal
  let response: Response
  try {
    response = await (plane.fetch ?? fetch)(new URL(path, `${plane.baseUrl}/`).toString(), {
      method,
      headers: {
        ...init.headers,
        authorization: `Bearer ${plane.token()}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal
    })
  } catch {
    throw new CloudRequestError(
      init.signal?.aborted ? 'aborted' : signal.aborted ? 'timeout' : 'network_error',
      0
    )
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', onAbort)
  }
  const raw: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const parsed = ErrorBodySchema.safeParse(raw)
    throw new CloudRequestError(
      parsed.data?.error ?? 'http_error',
      response.status,
      parsed.data?.reason
    )
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new CloudRequestError('invalid_response', response.status)
  }
  return parsed.data
}

/** Org registry first (titles, repos, cost); the owner-only lifecycle list until the registry ships. */
