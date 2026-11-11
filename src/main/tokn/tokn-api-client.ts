import { hostname } from 'node:os'
import { app } from 'electron'
import { getMainHttpClient } from '../network/http-client'
import type { ToknSyncErrorCode, ToknUploadPreview } from '../../shared/tokn-sync-status'
import { TOKN_CLIENT_ID, toknOwnedUrl } from './tokn-service-config'

const REQUEST_TIMEOUT_MS = 30_000

export class ToknRequestError extends Error {
  constructor(
    readonly code: ToknSyncErrorCode,
    readonly detail: string | null,
    readonly status: number | null
  ) {
    super(detail ?? code)
    this.name = 'ToknRequestError'
  }
}

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCodeForStatus(status: number): ToknSyncErrorCode {
  if (status === 401 || status === 403) {
    return 'signed-out'
  }
  if (status === 429) {
    return 'rate-limited'
  }
  if (status === 400 || status === 413) {
    return 'rejected'
  }
  return 'server'
}

async function postJson(
  origin: string,
  path: string,
  body: JsonObject,
  accessToken?: string
): Promise<JsonObject> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json'
  }
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`
  }
  let response: Response
  try {
    response = await getMainHttpClient().fetch(`${origin}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    throw new ToknRequestError('network', error instanceof Error ? error.message : null, null)
  }
  // Always read the body: unread undici bodies can crash the process.
  const text = await response.text().catch(() => '')
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = null
  }
  const json = isJsonObject(parsed) ? parsed : null
  if (!response.ok) {
    const detail = json?.error_description ?? json?.error
    throw new ToknRequestError(
      errorCodeForStatus(response.status),
      typeof detail === 'string' ? detail.slice(0, 300) : null,
      response.status
    )
  }
  if (!json) {
    throw new ToknRequestError('server', 'tokn returned a malformed response', response.status)
  }
  return json
}

export type ToknTokenGrant = {
  accessToken: string
  handle: string
  profileUrl: string | null
}

export async function exchangeToknAuthorizationCode(
  origin: string,
  grant: { code: string; codeVerifier: string; redirectUri: string }
): Promise<ToknTokenGrant> {
  const reply = await postJson(origin, '/api/oauth/token', {
    grant_type: 'authorization_code',
    client_id: TOKN_CLIENT_ID,
    code: grant.code,
    code_verifier: grant.codeVerifier,
    redirect_uri: grant.redirectUri,
    // Labels this computer in the account's device list on tokn, where it can be revoked.
    device_name: hostname(),
    platform: process.platform,
    app_version: app.getVersion()
  })
  const user = isJsonObject(reply.user) ? reply.user : null
  if (typeof reply.access_token !== 'string' || typeof user?.handle !== 'string') {
    throw new ToknRequestError('server', 'tokn returned an incomplete sign-in', null)
  }
  return {
    accessToken: reply.access_token,
    handle: user.handle,
    profileUrl: toknOwnedUrl(reply.profile_url, origin)
  }
}

export type ToknSyncReply = {
  accepted: number
  rejected: number
  profileUrl: string | null
}

export async function uploadToknUsage(
  origin: string,
  accessToken: string,
  body: ToknUploadPreview['body']
): Promise<ToknSyncReply> {
  const reply = await postJson(origin, '/api/cli/sync', body, accessToken)
  return {
    accepted: typeof reply.accepted === 'number' ? reply.accepted : 0,
    rejected: Array.isArray(reply.rejected) ? reply.rejected.length : 0,
    profileUrl: toknOwnedUrl(reply.profileUrl, origin)
  }
}

/** RFC 7009: tokn answers 200 whether or not the token was live. */
export async function revokeToknToken(origin: string, accessToken: string): Promise<void> {
  await postJson(origin, '/api/oauth/revoke', { token: accessToken, client_id: TOKN_CLIENT_ID })
}
