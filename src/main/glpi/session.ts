import type { GlpiServer } from '../../shared/types'
import { readCredentials, type GlpiCredentials } from './server-store'

// GLPI's classic REST API is session-based: initSession exchanges the
// App-Token + per-user API token for a short-lived Session-Token that every
// other call must carry. Tokens expire server-side, so we cache one per server
// and transparently re-init on a 401.

const MAX_CONCURRENT = 4
let running = 0
const queue: (() => void)[] = []

export function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1
    return Promise.resolve()
  }
  return new Promise((resolve) =>
    queue.push(() => {
      running += 1
      resolve()
    })
  )
}

export function release(): void {
  running -= 1
  const next = queue.shift()
  if (next) {
    next()
  }
}

export class GlpiApiError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

export function isAuthError(error: unknown): boolean {
  return error instanceof GlpiApiError && (error.status === 401 || error.status === 403)
}

const sessionTokens = new Map<string, string>()
// Why: dedupe concurrent initSession calls per server so a cold cache or a
// simultaneous expiry doesn't open (and orphan) N server-side sessions.
const openingSessions = new Map<string, Promise<string>>()

function ensureSession(server: GlpiServer, credentials: GlpiCredentials): Promise<string> {
  const cached = sessionTokens.get(server.id)
  if (cached) {
    return Promise.resolve(cached)
  }
  const inflight = openingSessions.get(server.id)
  if (inflight) {
    return inflight
  }
  const promise = openSession(server.apiBaseUrl, credentials)
    .then((token) => {
      sessionTokens.set(server.id, token)
      return token
    })
    .finally(() => {
      openingSessions.delete(server.id)
    })
  openingSessions.set(server.id, promise)
  return promise
}

async function readGlpiError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as unknown
    // GLPI errors come back as ["ERROR_CODE", "Human message"].
    if (Array.isArray(data) && data.length > 0) {
      return data.filter((part) => typeof part === 'string').join(': ') || response.statusText
    }
    if (data && typeof data === 'object' && 'message' in data) {
      const message = (data as { message?: unknown }).message
      if (typeof message === 'string' && message) {
        return message
      }
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `GLPI request failed (${response.status})`
}

// Opens a fresh session with explicit credentials. Used both for first-time
// connect (before anything is stored) and to refresh an expired session.
export async function openSession(
  apiBaseUrl: string,
  credentials: GlpiCredentials
): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/initSession`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `user_token ${credentials.userToken}`,
      'App-Token': credentials.appToken
    }
  })
  if (!response.ok) {
    throw new GlpiApiError(await readGlpiError(response), response.status)
  }
  const data = (await response.json()) as { session_token?: unknown }
  if (typeof data.session_token !== 'string' || !data.session_token) {
    throw new GlpiApiError('GLPI did not return a session token.', response.status)
  }
  return data.session_token
}

async function rawRequest<T>(
  apiBaseUrl: string,
  appToken: string,
  sessionToken: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('Session-Token', sessionToken)
  headers.set('App-Token', appToken)
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers })
  if (!response.ok) {
    throw new GlpiApiError(await readGlpiError(response), response.status)
  }
  if (response.status === 204) {
    return null as T
  }
  return (await response.json()) as T
}

// Runs an authenticated operation against a stored server: resolves credentials,
// reuses the cached session token, and re-inits once on a 401 (an expired/invalid
// session token; a 403 is a genuine authorization denial that re-init can't fix).
async function withSession<T>(
  server: GlpiServer,
  perform: (apiBaseUrl: string, appToken: string, sessionToken: string) => Promise<T>
): Promise<T> {
  const credentials = readCredentials(server.id)
  if (!credentials) {
    throw new GlpiApiError('Not connected to this GLPI server.', 401)
  }
  const sessionToken = await ensureSession(server, credentials)
  try {
    return await perform(server.apiBaseUrl, credentials.appToken, sessionToken)
  } catch (error) {
    if (!(error instanceof GlpiApiError) || error.status !== 401) {
      throw error
    }
    sessionTokens.delete(server.id)
    const refreshed = await ensureSession(server, credentials)
    return perform(server.apiBaseUrl, credentials.appToken, refreshed)
  }
}

export async function glpiServerRequest<T>(
  server: GlpiServer,
  path: string,
  init?: RequestInit
): Promise<T> {
  return withSession(server, (apiBaseUrl, appToken, sessionToken) =>
    rawRequest<T>(apiBaseUrl, appToken, sessionToken, path, init)
  )
}

export type GlpiBinaryResponse = { data: Buffer; contentType: string }

async function rawBinary(
  apiBaseUrl: string,
  appToken: string,
  sessionToken: string,
  path: string
): Promise<GlpiBinaryResponse | null> {
  const headers = new Headers()
  headers.set('Accept', 'application/octet-stream')
  headers.set('Session-Token', sessionToken)
  headers.set('App-Token', appToken)
  const response = await fetch(`${apiBaseUrl}${path}`, { headers })
  if (!response.ok) {
    throw new GlpiApiError(await readGlpiError(response), response.status)
  }
  if (response.status === 204) {
    return null
  }
  return {
    data: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? 'application/octet-stream'
  }
}

// Downloads a binary resource (e.g. a Document) with the same session handling.
export async function glpiServerRequestBinary(
  server: GlpiServer,
  path: string
): Promise<GlpiBinaryResponse | null> {
  return withSession(server, (apiBaseUrl, appToken, sessionToken) =>
    rawBinary(apiBaseUrl, appToken, sessionToken, path)
  )
}

export type GlpiFullSession = {
  glpiID: number
  glpiname: string
  glpifriendlyname: string | null
}

export async function getFullSession(
  apiBaseUrl: string,
  appToken: string,
  sessionToken: string
): Promise<GlpiFullSession> {
  const data = await rawRequest<{ session?: Record<string, unknown> }>(
    apiBaseUrl,
    appToken,
    sessionToken,
    '/getFullSession'
  )
  const session = data.session ?? {}
  return {
    glpiID: typeof session.glpiID === 'number' ? session.glpiID : 0,
    glpiname: typeof session.glpiname === 'string' ? session.glpiname : '',
    glpifriendlyname: typeof session.glpifriendlyname === 'string' ? session.glpifriendlyname : null
  }
}

export function clearSession(serverId: string): void {
  sessionTokens.delete(serverId)
}
