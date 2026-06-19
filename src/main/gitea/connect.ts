import type {
  GiteaConnectArgs,
  GiteaConnectionStatus,
  GiteaServer,
  GiteaServerSelection,
  GiteaViewer
} from '../../shared/gitea-types'
import {
  deleteToken,
  deriveGiteaWebBaseUrl,
  getCredentialError,
  getGiteaServerId,
  getServerFile,
  getServerTokens,
  hasStoredToken,
  normalizeGiteaApiBaseUrl,
  saveToken,
  writeServerFile
} from './server-store'

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
    const response = await fetch(`${apiBaseUrl}/user`, {
      headers: authHeaders(token),
      signal: controller.signal
    })
    if (response.status === 401) {
      return { ok: false, error: 'Gitea rejected the token. Check that it is valid.' }
    }
    // Why: a 403 on /user means the token authenticated but lacks the read:user
    // scope. The token is still valid and usable for issues, so accept the
    // connection without an account label rather than forcing a broader scope.
    if (response.status === 403) {
      return { ok: true, viewer: { login: '', fullName: null } }
    }
    if (!response.ok) {
      return { ok: false, error: `Gitea request failed (${response.status}).` }
    }
    const viewer = toViewer((await response.json()) as RawGiteaUser)
    return { ok: true, viewer }
  } catch {
    return { ok: false, error: 'Could not reach the Gitea server.' }
  } finally {
    clearTimeout(timeout)
  }
}

export function getStatus(): GiteaConnectionStatus {
  const file = getServerFile()
  const servers = file.servers.filter((server) => hasStoredToken(server.id))
  const activeServer =
    servers.find((server) => server.id === file.activeServerId) ?? servers[0] ?? null
  // Why: keep the reported selection valid — 'all' is always allowed, otherwise
  // it must point at a still-connected server (fall back to the active one).
  const selectedServerId =
    file.selectedServerId === 'all' || servers.some((server) => server.id === file.selectedServerId)
      ? file.selectedServerId
      : (activeServer?.id ?? null)
  const credentialError = getCredentialError(servers.map((server) => server.id))
  return {
    connected: servers.length > 0,
    servers,
    activeServerId: activeServer?.id ?? null,
    selectedServerId: selectedServerId ?? activeServer?.id ?? null,
    ...(credentialError ? { credentialError } : {})
  }
}

export async function connect(
  args: GiteaConnectArgs
): Promise<{ ok: true; viewer: GiteaViewer } | { ok: false; error: string }> {
  let apiBaseUrl: string
  try {
    apiBaseUrl = normalizeGiteaApiBaseUrl(args.baseUrl)
    // Reject inputs that do not parse as URLs (normalize only trims/suffixes).
    new URL(apiBaseUrl)
  } catch {
    return { ok: false, error: 'Enter a valid Gitea server URL.' }
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
  saveToken(id, token)
  const file = getServerFile()
  writeServerFile({
    version: 1,
    activeServerId: id,
    selectedServerId: id,
    servers: [server, ...file.servers.filter((entry) => entry.id !== id)]
  })
  return { ok: true, viewer: result.viewer }
}

export function disconnect(serverId?: string): void {
  const file = getServerFile()
  const ids = serverId ? [serverId] : file.servers.map((server) => server.id)
  for (const id of ids) {
    deleteToken(id)
  }
  const servers = file.servers.filter((server) => !ids.includes(server.id))
  // Why: don't leave active/selected pointing at a removed server.
  const activeServerId =
    servers.find((server) => server.id === file.activeServerId)?.id ?? servers[0]?.id ?? null
  const selectedServerId =
    file.selectedServerId === 'all' || servers.some((server) => server.id === file.selectedServerId)
      ? file.selectedServerId
      : activeServerId
  writeServerFile({
    version: 1,
    activeServerId,
    selectedServerId,
    servers
  })
}

export function selectServer(selection: GiteaServerSelection): GiteaConnectionStatus {
  const file = getServerFile()
  if (selection !== 'all' && !file.servers.some((server) => server.id === selection)) {
    return getStatus()
  }
  writeServerFile({
    ...file,
    activeServerId: selection === 'all' ? file.activeServerId : selection,
    selectedServerId: selection
  })
  return getStatus()
}

export async function testConnection(
  serverId?: string
): Promise<{ ok: true; viewer: GiteaViewer } | { ok: false; error: string }> {
  let entry: ReturnType<typeof getServerTokens>[number] | undefined
  try {
    entry = getServerTokens(serverId)[0]
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
