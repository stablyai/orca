import type {
  GiteaConnectArgs,
  GiteaConnectionStatus,
  GiteaServer,
  GiteaViewer
} from '../../../shared/gitea/gitea-types'
import {
  deleteToken,
  deriveGiteaWebBaseUrl,
  getCredentialError,
  getGiteaServerId,
  getServerFile,
  getServerTokens,
  inServerRegistryOrder,
  type GiteaServerToken,
  normalizeGiteaApiBaseUrl,
  saveToken,
  writeServerFile
} from './gitea-server-store'
import { validateGiteaApiUrl } from '../requests/gitea-api-url'
import { z } from 'zod'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'

const USER_REQUEST_TIMEOUT_MS = 8000

type RawGiteaUser = {
  login?: string | null
  username?: string | null
  full_name?: string | null
  avatar_url?: string | null
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `token ${token}`, Accept: 'application/json' }
}

function toViewer(raw: RawGiteaUser): GiteaViewer {
  const login = raw.login?.trim() || raw.username?.trim() || ''
  return {
    login,
    fullName: raw.full_name?.trim() || null,
    avatarUrl: raw.avatar_url?.trim() || undefined
  }
}

// Validates a token against a Gitea server by reading the authenticated user.
async function fetchGiteaUser(
  apiBaseUrl: string,
  token: string
): Promise<{ ok: true; viewer: GiteaViewer } | { ok: false; error: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), USER_REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${validateGiteaApiUrl(apiBaseUrl)}/user`, {
      redirect: 'error',
      headers: authHeaders(token),
      signal: controller.signal
    })
    if (response.status === 401) {
      await cancelUnreadResponseBody(response)
      return { ok: false, error: 'Gitea rejected the token. Check that it is valid.' }
    }
    // Why: a 403 on /user means the token authenticated but lacks the read:user
    // scope. The token is still valid and usable for issues, so accept the
    // connection without an account label rather than forcing a broader scope.
    if (response.status === 403) {
      await cancelUnreadResponseBody(response)
      return { ok: true, viewer: { login: '', fullName: null } }
    }
    if (!response.ok) {
      await cancelUnreadResponseBody(response)
      return { ok: false, error: `Gitea request failed (${response.status}).` }
    }
    const viewer = toViewer(
      z
        .object({
          login: z.string().nullable().optional(),
          username: z.string().nullable().optional(),
          full_name: z.string().nullable().optional(),
          avatar_url: z.string().nullable().optional()
        })
        .parse(await response.json())
    )
    return { ok: true, viewer }
  } catch {
    return { ok: false, error: 'Could not reach the Gitea server.' }
  } finally {
    clearTimeout(timeout)
  }
}

export async function getStatus(): Promise<GiteaConnectionStatus> {
  // getServerFile already drops tokenless servers and repairs the selection.
  const file = await getServerFile()
  const usableServers = await getServerTokens()
  const credentialError = await getCredentialError(file.servers.map((server) => server.id))
  return {
    connected: usableServers.length > 0,
    servers: file.servers,
    ...(credentialError ? { credentialError } : {})
  }
}

export async function connect(
  args: GiteaConnectArgs
): Promise<{ ok: true; viewer: GiteaViewer } | { ok: false; error: string }> {
  let apiBaseUrl: string
  try {
    new URL(args.baseUrl)
  } catch {
    return { ok: false, error: 'Enter a valid Gitea server URL.' }
  }
  try {
    apiBaseUrl = normalizeGiteaApiBaseUrl(validateGiteaApiUrl(args.baseUrl))
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Enter a valid Gitea server URL.'
    }
  }

  const token = args.token.trim()
  if (!token) {
    return { ok: false, error: 'An access token is required.' }
  }

  const result = await fetchGiteaUser(apiBaseUrl, token)
  if (!result.ok) {
    return result
  }

  const id = getGiteaServerId(apiBaseUrl)
  const baseUrl = deriveGiteaWebBaseUrl(apiBaseUrl)
  const server: GiteaServer = {
    id,
    baseUrl,
    apiBaseUrl,
    displayName: hostLabel(baseUrl),
    account: result.viewer.login || null
  }
  await inServerRegistryOrder(async () => {
    await saveToken(id, token)
    const file = await getServerFile()
    await writeServerFile({
      version: 1,
      servers: [server, ...file.servers.filter((entry) => entry.id !== id)]
    })
  })
  return { ok: true, viewer: result.viewer }
}

export async function disconnect(serverId?: string): Promise<void> {
  await inServerRegistryOrder(async () => {
    const file = await getServerFile()
    const ids = serverId ? [serverId] : file.servers.map((server) => server.id)
    await Promise.all(ids.map((id) => deleteToken(id)))
    await writeServerFile({
      version: 1,
      servers: file.servers.filter((server) => !ids.includes(server.id))
    })
  })
}

export async function testConnection(
  serverId?: string
): Promise<{ ok: true; viewer: GiteaViewer } | { ok: false; error: string }> {
  let entry: GiteaServerToken | undefined
  try {
    entry = (await getServerTokens(serverId))[0]
  } catch {
    return { ok: false, error: 'Could not decrypt the saved Gitea credential.' }
  }
  if (!entry) {
    return { ok: false, error: 'Not connected to Gitea.' }
  }
  return fetchGiteaUser(entry.server.apiBaseUrl, entry.token)
}

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}
