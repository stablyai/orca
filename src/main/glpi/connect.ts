import type {
  GlpiConnectArgs,
  GlpiConnectionStatus,
  GlpiServer,
  GlpiServerSelection,
  GlpiViewer
} from '../../shared/types'
import { CredentialDecryptionError } from '../integration-credential-file'
import {
  deleteCredentials,
  getCredentialError,
  getServerFile,
  getServerId,
  glpiApiBaseFromWeb,
  hasStoredCredentials,
  normalizeGlpiBaseUrl,
  readCredentials,
  saveCredentials,
  writeServerFile
} from './server-store'
import { clearSession, getFullSession, openSession } from './session'

type ConnectResult = { ok: true; viewer: GlpiViewer } | { ok: false; error: string }

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export function getStatus(): GlpiConnectionStatus {
  const file = getServerFile()
  const servers = file.servers.filter((server) => hasStoredCredentials(server.id))
  const activeServer =
    servers.find((server) => server.id === file.activeServerId) ?? servers[0] ?? null
  const credentialError = servers
    .map((server) => getCredentialError(server.id))
    .find((message) => message !== undefined)
  const viewer: GlpiViewer | null = activeServer
    ? { id: 0, login: activeServer.account ?? '', fullName: activeServer.account }
    : null
  return {
    connected: servers.length > 0,
    viewer,
    servers,
    activeServerId: activeServer?.id ?? null,
    selectedServerId: file.selectedServerId ?? activeServer?.id ?? null,
    ...(credentialError ? { credentialError } : {})
  }
}

export async function connect(args: GlpiConnectArgs): Promise<ConnectResult> {
  let baseUrl: string
  try {
    baseUrl = normalizeGlpiBaseUrl(args.baseUrl)
  } catch {
    return { ok: false, error: 'Enter a valid GLPI URL.' }
  }
  const appToken = args.appToken.trim()
  const userToken = args.userToken.trim()
  if (!appToken || !userToken) {
    return { ok: false, error: 'Application token and user API token are required.' }
  }

  const apiBaseUrl = glpiApiBaseFromWeb(baseUrl)
  try {
    const credentials = { appToken, userToken }
    const sessionToken = await openSession(apiBaseUrl, credentials)
    const full = await getFullSession(apiBaseUrl, appToken, sessionToken)
    const id = getServerId(baseUrl)
    const viewer: GlpiViewer = {
      id: full.glpiID,
      login: full.glpiname,
      fullName: full.glpifriendlyname
    }
    const server: GlpiServer = {
      id,
      baseUrl,
      apiBaseUrl,
      displayName: hostLabel(baseUrl),
      account: full.glpiname || null
    }
    saveCredentials(id, credentials)
    const file = getServerFile()
    writeServerFile({
      version: 1,
      activeServerId: id,
      selectedServerId: id,
      servers: [server, ...file.servers.filter((entry) => entry.id !== id)]
    })
    clearSession(id)
    return { ok: true, viewer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  }
}

export function disconnect(serverId?: string): void {
  const file = getServerFile()
  const ids = serverId ? [serverId] : file.servers.map((server) => server.id)
  for (const id of ids) {
    deleteCredentials(id)
    clearSession(id)
  }
  writeServerFile({
    version: 1,
    activeServerId: file.activeServerId,
    selectedServerId: file.selectedServerId,
    servers: file.servers.filter((server) => !ids.includes(server.id))
  })
}

export function selectServer(serverId: GlpiServerSelection): GlpiConnectionStatus {
  const file = getServerFile()
  if (serverId !== 'all' && !file.servers.some((server) => server.id === serverId)) {
    return getStatus()
  }
  writeServerFile({
    ...file,
    activeServerId: serverId === 'all' ? file.activeServerId : serverId,
    selectedServerId: serverId
  })
  return getStatus()
}

export async function testConnection(serverId?: string): Promise<ConnectResult> {
  const file = getServerFile()
  const server = serverId
    ? file.servers.find((entry) => entry.id === serverId)
    : (file.servers.find((entry) => entry.id === file.activeServerId) ?? file.servers[0])
  if (!server) {
    return { ok: false, error: 'Not connected to GLPI.' }
  }
  let credentials: ReturnType<typeof readCredentials>
  try {
    credentials = readCredentials(server.id)
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      return { ok: false, error: error.message }
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  }
  if (!credentials) {
    return { ok: false, error: 'Not connected to GLPI.' }
  }
  try {
    const sessionToken = await openSession(server.apiBaseUrl, credentials)
    const full = await getFullSession(server.apiBaseUrl, credentials.appToken, sessionToken)
    clearSession(server.id)
    return {
      ok: true,
      viewer: { id: full.glpiID, login: full.glpiname, fullName: full.glpifriendlyname }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  }
}
