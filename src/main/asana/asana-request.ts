import type { AsanaWorkspace } from '../../shared/types'

// Why: Asana's REST base is fixed (unlike Jira's per-site host), so clients
// only carry the bearer token; every request targets this origin.
export const ASANA_API_BASE = 'https://app.asana.com/api/1.0'
// Why: every Asana call funnels through the shared fetch helpers; without a
// timeout a stalled socket hangs the main-process operation indefinitely.
const ASANA_REQUEST_TIMEOUT_MS = 30_000

export type AsanaClientForWorkspace = {
  workspace: AsanaWorkspace
  authorization: string
}

export type AsanaMeResponse = {
  data?: {
    gid?: string
    name?: string
    email?: string
    workspaces?: { gid?: string; name?: string }[]
  }
}

export class AsanaApiError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

export function authHeader(apiToken: string): string {
  return `Bearer ${apiToken}`
}

async function readAsanaError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as {
      errors?: { message?: string }[]
    }
    const messages = (data.errors ?? [])
      .map((error) => error.message)
      .filter((message): message is string => Boolean(message))
    if (messages.length > 0) {
      return messages.join('; ')
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `Asana request failed (${response.status})`
}

export async function requestWithToken(
  apiToken: string,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', authHeader(apiToken))
  const response = await fetch(`${ASANA_API_BASE}${path}`, {
    signal: AbortSignal.timeout(ASANA_REQUEST_TIMEOUT_MS),
    ...init,
    headers
  })
  if (!response.ok) {
    throw new AsanaApiError(await readAsanaError(response), response.status)
  }
  if (response.status === 204) {
    return null
  }
  return response.json()
}

export async function asanaRequest<T>(
  client: AsanaClientForWorkspace,
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', client.authorization)
  const response = await fetch(`${ASANA_API_BASE}${path}`, {
    signal: AbortSignal.timeout(ASANA_REQUEST_TIMEOUT_MS),
    ...init,
    headers
  })
  if (!response.ok) {
    throw new AsanaApiError(await readAsanaError(response), response.status)
  }
  if (response.status === 204) {
    return null as T
  }
  return (await response.json()) as T
}
