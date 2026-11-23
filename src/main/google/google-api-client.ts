// Calls Google's APIs as one account signed in on this host: picks the account, keeps its token
// fresh (retrying once when Google refuses a token it still thinks is good), and turns Google's
// errors into one sentence that says what to do. Every Google tool calls through here.
import type { z } from 'zod'
import type { GoogleService } from '../../shared/google/google-scopes'
import { formatMegabytes, TOOL_DOWNLOAD_MAX_BYTES } from '../../shared/tool-output-limits'
import { googleApiEnableUrl } from '../../shared/google/google-scopes'
import {
  defaultGoogleTokenDeps,
  googleAccessToken,
  refreshGoogleAccount,
  type GoogleTokenDeps
} from './google-account-tokens'
import { readGoogleAccount, resolveGoogleDefaultAccount } from './google-credential-store'
import { classifyGoogleApiError, readGoogleApiError } from './google-readiness'

const REQUEST_TIMEOUT_MS = 20_000

export class GoogleToolError extends Error {
  /** Google's HTTP status, when Google answered; a checker backs off on 429. */
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GoogleToolError'
    if (status !== undefined) {
      this.status = status
    }
  }
}

/** The account a command acts as: the one named, else this computer's default. */
export async function resolveGoogleAccount(wanted: string | undefined): Promise<string> {
  if (wanted) {
    const record = await readGoogleAccount(wanted)
    if (!record) {
      throw new GoogleToolError(
        `${wanted} isn't connected on this computer. \`orca google status\` lists the accounts here.`
      )
    }
    return record.email
  }
  const fallback = await resolveGoogleDefaultAccount()
  if (!fallback) {
    throw new GoogleToolError(
      'No Google account is connected on this computer. Ask your owner to connect one in Orca.'
    )
  }
  return fallback
}

/** A body read with a schema: the value, or null when Google answered in another shape. */
export const parseGoogleJson =
  <T>(schema: z.ZodType<T>) =>
  (body: unknown): T | null =>
    schema.safeParse(body).data ?? null

function parseBody(text: string): unknown {
  if (!text) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return null
  }
}

/** A write: JSON (the usual), or raw bytes such as an upload or a MIME message. */
export type GoogleWrite = {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  json?: unknown
  raw?: { body: Uint8Array<ArrayBuffer> | string; contentType: string }
}

export type GoogleApi = {
  /** The account's address, for output that says whose mail or calendar it is. */
  email: string
  get: <T>(service: GoogleService, url: string, read: (body: unknown) => T | null) => Promise<T>
  /** Like get, but null when Google says the thing doesn't exist (404). */
  find: <T>(
    service: GoogleService,
    url: string,
    read: (body: unknown) => T | null
  ) => Promise<T | null>
  /** A write; `read` gets Google's answer (an empty body reads as null, e.g. after DELETE). */
  send: <T>(
    service: GoogleService,
    write: GoogleWrite,
    read: (body: unknown) => T | null
  ) => Promise<T>
  /** A file's bytes, refused with a sentence once they pass `maxBytes`. */
  bytes: (service: GoogleService, url: string, maxBytes?: number) => Promise<Uint8Array>
}

type Request = {
  method: string
  url: string
  body?: Uint8Array<ArrayBuffer> | string
  contentType?: string
}

export async function googleApi(
  wantedAccount: string | undefined,
  deps: GoogleTokenDeps = defaultGoogleTokenDeps
): Promise<GoogleApi> {
  const email = await resolveGoogleAccount(wantedAccount)
  const projectId = (await readGoogleAccount(email))?.projectId

  /** A token that still works; after a refusal, a renewed one or the account's own reason. */
  async function token(renew: boolean): Promise<string> {
    if (!renew) {
      return googleAccessToken(email, deps)
    }
    const record = await refreshGoogleAccount(email, deps, true)
    if (record.status !== 'connected' || !record.accessToken) {
      throw new GoogleToolError(
        `${record.reason ?? 'Google access ended.'} Ask your owner to reconnect ${email} in Orca.`
      )
    }
    return record.accessToken
  }

  async function call(request: Request, retried = false): Promise<Response> {
    const bearer = await token(retried)
    let response: Response
    try {
      response = await deps.http(request.url, {
        method: request.method,
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(request.contentType ? { 'content-type': request.contentType } : {})
        },
        ...(request.body !== undefined ? { body: request.body } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch {
      throw new GoogleToolError("Couldn't reach Google. Try again in a moment.")
    }
    // A token can be refused before its saved expiry (revoked session, clock skew): renew once.
    // Retrying a write is safe too: Google acted on nothing it refused.
    return response.status === 401 && !retried ? call(request, true) : response
  }

  async function fail(service: GoogleService, response: Response): Promise<never> {
    const body: unknown = await response.json().catch(() => null)
    throw new GoogleToolError(
      failureSentence(service, response.status, body, projectId),
      response.status
    )
  }

  async function json<T>(
    service: GoogleService,
    request: Request,
    read: (body: unknown) => T | null,
    absentIsNull: boolean
  ): Promise<T | null> {
    const response = await call(request)
    if (absentIsNull && response.status === 404) {
      return null
    }
    if (!response.ok) {
      return fail(service, response)
    }
    const value = read(parseBody(await response.text()))
    if (value === null) {
      throw new GoogleToolError('Google answered in a shape Orca does not understand.')
    }
    return value
  }

  return {
    email,
    get: async (service, url, read) => {
      const value = await json(service, { method: 'GET', url }, read, false)
      if (value === null) {
        throw new GoogleToolError('Google found nothing there.')
      }
      return value
    },
    find: (service, url, read) => json(service, { method: 'GET', url }, read, true),
    send: async (service, write, read) => {
      const body =
        write.raw?.body ?? (write.json !== undefined ? JSON.stringify(write.json) : undefined)
      const contentType =
        write.raw?.contentType ?? (write.json !== undefined ? 'application/json' : undefined)
      const value = await json(
        service,
        {
          method: write.method,
          url: write.url,
          ...(body !== undefined ? { body } : {}),
          ...(contentType ? { contentType } : {})
        },
        read,
        false
      )
      if (value === null) {
        throw new GoogleToolError('Google answered in a shape Orca does not understand.')
      }
      return value
    },
    bytes: async (service, url, maxBytes = TOOL_DOWNLOAD_MAX_BYTES) => {
      const response = await call({ method: 'GET', url })
      if (!response.ok) {
        return fail(service, response)
      }
      const tooLarge = () =>
        new GoogleToolError(
          `That file is larger than ${formatMegabytes(maxBytes)}, more than Orca hands an agent at once. Open it in Google instead.`
        )
      if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
        await response.body?.cancel().catch(() => undefined)
        throw tooLarge()
      }
      const chunks: Uint8Array[] = []
      let total = 0
      const reader = response.body?.getReader()
      while (reader) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined)
          throw tooLarge()
        }
        chunks.push(value)
      }
      return Buffer.concat(chunks)
    }
  }
}

function failureSentence(
  service: GoogleService,
  status: number,
  body: unknown,
  projectId: string | undefined
): string {
  const readiness = classifyGoogleApiError(service, readGoogleApiError(status, body), projectId)
  switch (readiness.state) {
    case 'api-disabled':
      return `${readiness.detail ?? 'This Google API is turned off.'} Ask your owner to turn it on: ${readiness.enableUrl ?? googleApiEnableUrl(service, projectId)}`
    case 'needs-permission':
      return 'Google access for this was not allowed. Ask your owner to reconnect it in Orca and allow it.'
    case 'blocked-by-admin':
      return `Your owner's company Google admin blocked this: ${readiness.detail ?? ''}`.trim()
    case 'ready':
    case 'error':
      return status === 401
        ? 'Google refused the sign-in. Ask your owner to reconnect it in Orca.'
        : status === 429
          ? 'Google says too many requests right now. Wait a minute and try again.'
          : `Google refused: ${readiness.detail ?? `HTTP ${status}`}`
  }
}
