// One Microsoft Teams sign-in, run on the host that keeps the grant, through the person's own Entra
// app with the device code flow: the host shows a code, the person enters it on Microsoft's page from
// any device, and the host polls for the tokens. Nothing comes back to a port here, so it works the
// same on a desktop, a headless server and over SSH.
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { TeamsSignInPrompt } from '../../shared/teams/teams-connect-types'
import type { CallerOwnedSignInChannel } from '../runtime/caller-owned-sign-in-flows'
import { saveTeamsAccount, type TeamsAccountRecord } from './teams-credential-store'
import { teamsSignInScopes } from './teams-scopes'

export type TeamsHttp = typeof fetch
export const defaultTeamsHttp: TeamsHttp = (input, init) => fetch(input, init)

export type TeamsSignInDeps = {
  http: TeamsHttp
  now: () => number
  /** Waits between polls; rejects when the signal aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

export const defaultTeamsSignInDeps: TeamsSignInDeps = {
  http: defaultTeamsHttp,
  now: Date.now,
  sleep: (ms, signal) => delay(ms, undefined, { signal })
}

export type TeamsSignInInput = { tenantId: string; clientId: string; channels: boolean }

const REQUEST_TIMEOUT_MS = 15_000
const MAX_POLL_INTERVAL_MS = 60_000
export const GRAPH_ME_URL =
  'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName'

const authority = (tenantId: string) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0`
export const teamsTokenUrl = (tenantId: string) => `${authority(tenantId)}/token`

const DeviceCode = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  expires_in: z.number().positive(),
  interval: z.number().positive().optional()
})
const Tokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional()
})
const OAuthError = z.object({ error: z.string(), error_description: z.string().optional() })
const Me = z.object({
  id: z.string().min(1),
  displayName: z.string().nullable().optional(),
  mail: z.string().nullable().optional(),
  userPrincipalName: z.string().nullable().optional()
})

// Microsoft's AADSTS codes that say what to fix in the app registration.
const APP_PROBLEMS: Record<string, string> = {
  AADSTS7000218:
    'Your Entra app does not allow public client flows. In its Authentication page, turn on "Allow public client flows", then try again.',
  AADSTS700016: 'Microsoft does not know that client id in this tenant. Check both ids.',
  AADSTS90002: 'Microsoft does not know that tenant. Check the tenant id or domain.',
  AADSTS65001:
    'Your organization needs an admin to approve these permissions for your app. Ask one, or connect with --chats-only.'
}

function oauthMessage(body: unknown, fallback: string): string {
  const parsed = OAuthError.safeParse(body).data
  if (!parsed) {
    return fallback
  }
  const code = parsed.error_description?.match(/AADSTS\d+/)?.[0]
  const known = code ? APP_PROBLEMS[code] : undefined
  if (known) {
    return known
  }
  // The description's first line names the problem; the rest is trace and correlation ids.
  const first = parsed.error_description?.split(/\r?\n/)[0]?.trim()
  return first
    ? `${fallback} Microsoft said: ${first.slice(0, 300)}`
    : `${fallback} (${parsed.error})`
}

async function postForm(
  deps: TeamsSignInDeps,
  url: string,
  form: Record<string, string>,
  signal: AbortSignal
): Promise<{ ok: boolean; body: unknown }> {
  const response = await deps.http(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
  })
  return { ok: response.ok, body: await response.json().catch(() => null) }
}

/** Polls until the person finishes, declines, or the code expires (RFC 8628 §3.5). */
async function pollForTokens(
  deps: TeamsSignInDeps,
  input: TeamsSignInInput,
  code: z.infer<typeof DeviceCode>,
  expiresAt: number,
  signal: AbortSignal
): Promise<z.infer<typeof Tokens>> {
  let intervalMs = (code.interval ?? 5) * 1000
  for (;;) {
    await deps.sleep(intervalMs, signal)
    if (deps.now() >= expiresAt) {
      throw new Error('The Microsoft sign-in code expired. Run `orca teams connect` again.')
    }
    const answer = await postForm(
      deps,
      teamsTokenUrl(input.tenantId),
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: input.clientId,
        device_code: code.device_code
      },
      signal
    ).catch((error: unknown) => {
      // A dropped request is retried at a slower interval (RFC 8628 §3.5); a cancel ends the loop.
      if (signal.aborted) {
        throw error
      }
      return null
    })
    if (!answer) {
      intervalMs = Math.min(intervalMs * 2, MAX_POLL_INTERVAL_MS)
      continue
    }
    if (answer.ok) {
      const tokens = Tokens.safeParse(answer.body).data
      if (!tokens) {
        throw new Error('Microsoft answered the sign-in without tokens. Try again.')
      }
      return tokens
    }
    const error = OAuthError.safeParse(answer.body).data?.error
    if (error === 'authorization_pending') {
      continue
    }
    if (error === 'slow_down') {
      intervalMs += 5_000
      continue
    }
    if (error === 'authorization_declined' || error === 'access_denied') {
      throw new Error('The Microsoft sign-in was declined.')
    }
    if (error === 'expired_token') {
      throw new Error('The Microsoft sign-in code expired. Run `orca teams connect` again.')
    }
    throw new Error(oauthMessage(answer.body, 'The Microsoft sign-in failed.'))
  }
}

export async function runTeamsDeviceSignIn(
  deps: TeamsSignInDeps,
  input: TeamsSignInInput,
  channel: CallerOwnedSignInChannel<TeamsSignInPrompt, never>
): Promise<TeamsAccountRecord> {
  const { signal } = channel
  const scopes = teamsSignInScopes(input.channels)
  const started = await postForm(
    deps,
    `${authority(input.tenantId)}/devicecode`,
    { client_id: input.clientId, scope: scopes.join(' ') },
    signal
  )
  const code = started.ok ? DeviceCode.safeParse(started.body).data : undefined
  if (!code) {
    throw new Error(oauthMessage(started.body, "Microsoft didn't start the sign-in."))
  }
  const expiresAt = deps.now() + code.expires_in * 1000
  channel.onPrompt({ verificationUri: code.verification_uri, userCode: code.user_code, expiresAt })
  const tokens = await pollForTokens(deps, input, code, expiresAt, signal)
  if (!tokens.refresh_token) {
    throw new Error("Microsoft didn't return a refresh token. Try again.")
  }
  const me = await deps.http(GRAPH_ME_URL, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
  })
  const person = me.ok ? Me.safeParse(await me.json().catch(() => null)).data : undefined
  if (!person) {
    throw new Error("Signed in, but Microsoft Graph wouldn't say who you are. Try again.")
  }
  const now = deps.now()
  const record: TeamsAccountRecord = {
    tenantId: input.tenantId,
    clientId: input.clientId,
    userId: person.id,
    name: person.displayName?.trim() || person.userPrincipalName || person.id,
    email: person.mail ?? person.userPrincipalName ?? null,
    channels: input.channels,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: now + tokens.expires_in * 1000,
    grantedScopes: tokens.scope?.split(' ').filter(Boolean) ?? scopes,
    status: 'connected',
    connectedAt: now
  }
  // A disconnect or cancel before the save finishes wins: the grant is not kept.
  await saveTeamsAccount(record, { signal }).catch((error: unknown) => {
    throw signal.aborted ? new Error('The Microsoft sign-in was cancelled.') : error
  })
  return record
}
