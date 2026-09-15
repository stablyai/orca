import type {
  CustomGitServer,
  CustomGitServerDraft,
  CustomGitServerStatus,
  CustomGitServerTestResult
} from '../../shared/custom-git-server'
import {
  computeCustomGitServerId,
  getCustomGitServerById,
  getCustomGitServerForHost,
  listCustomGitServers,
  normalizeCustomGitServerDraft,
  writeCustomGitServerConfig,
  _resetCustomGitServerStoreCache
} from './server-config-store'
import {
  deleteCustomGitServerToken,
  getCustomGitServerToken,
  hasStoredCustomGitServerToken,
  saveCustomGitServerToken,
  _resetCustomGitServerTokenCache
} from './token-store'
import { getCustomGitServerFlavorClient } from './api-flavor'

// Facade over the electron-free config store and the electron-backed token
// store. IPC + preflight consume this; forge-provider detection deliberately
// depends only on the config store (host match) to stay electron-free.
export {
  getCustomGitServerById,
  getCustomGitServerForHost,
  getCustomGitServerToken,
  listCustomGitServers
}

/** @internal - exposed for tests only */
export function _resetCustomGitServerStore(): void {
  _resetCustomGitServerStoreCache()
  _resetCustomGitServerTokenCache()
  verificationCache.clear()
}

// Why: preflight polls getCustomGitServerStatuses, so cache each server's live
// verify() briefly to avoid hammering the configured host on every tick. The
// in-flight promise is cached so concurrent ticks share one request.
const STATUS_VERIFY_TTL_MS = 30_000
const verificationCache = new Map<
  string,
  { expiresAt: number; result: Promise<CustomGitServerTestResult> }
>()

function invalidateServerVerification(id: string): void {
  verificationCache.delete(id)
}

/**
 * Create or update a server. When `id` is provided the record is updated in
 * place (identity preserved); otherwise a deterministic id from host+apiBaseUrl
 * is used (idempotent upsert). A non-empty `token` is saved; omitting it keeps
 * any existing token.
 */
export function saveCustomGitServer(
  draft: CustomGitServerDraft & { id?: string }
): CustomGitServer {
  const normalized = normalizeCustomGitServerDraft(draft)
  const id = draft.id ?? computeCustomGitServerId(normalized.host, normalized.apiBaseUrl)
  const server: CustomGitServer = { id, ...normalized }

  const writingToken = Boolean(draft.token && draft.token.trim())
  // Why: config + token live in two stores. Write the token first, but if the
  // config write then fails, roll the token back so a failed save leaves both
  // stores as they were rather than mutating the token for an unchanged config.
  let tokenRollback: (() => void) | null = null
  if (writingToken) {
    const hadToken = hasStoredCustomGitServerToken(id)
    const priorToken = hadToken ? safeReadToken(id) : null
    saveCustomGitServerToken(id, draft.token!.trim())
    tokenRollback = () => {
      if (priorToken !== null) {
        saveCustomGitServerToken(id, priorToken)
      } else if (!hadToken) {
        deleteCustomGitServerToken(id)
      }
    }
  }

  const servers = listCustomGitServers().filter((existing) => existing.id !== id)
  try {
    writeCustomGitServerConfig([...servers, server])
  } catch (error) {
    // Undo the token mutation so the failure is atomic from the caller's view.
    tokenRollback?.()
    throw error
  }
  // Why: config/token just changed, so a cached auth result for this id is stale.
  invalidateServerVerification(id)
  return server
}

/** Delete a server and its stored token. */
export function removeCustomGitServer(id: string): void {
  // Why: config is the source of truth, so drop it first. If this throws the
  // token is left intact (config still references the server). Deleting the
  // token only after the config write commits means a delete failure there
  // leaves a harmless orphaned token, never a configured server with no token.
  writeCustomGitServerConfig(listCustomGitServers().filter((server) => server.id !== id))
  deleteCustomGitServerToken(id)
  invalidateServerVerification(id)
}

/** Read a token without throwing on an undecryptable value (used for rollback). */
function safeReadToken(id: string): string | null {
  try {
    return getCustomGitServerToken(id)
  } catch {
    return null
  }
}

async function verifyServer(
  server: CustomGitServer,
  token: string
): Promise<CustomGitServerTestResult> {
  try {
    const result = await getCustomGitServerFlavorClient(server.apiFlavor).verify(server, token)
    return result
      ? { ok: true, account: result.account }
      : { ok: false, error: 'The server rejected the token or could not be reached.' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Verify a token against a server definition without persisting anything. */
export async function testCustomGitServerConnection(
  draft: CustomGitServerDraft & { token: string }
): Promise<CustomGitServerTestResult> {
  const normalized = normalizeCustomGitServerDraft(draft)
  if (!normalized.host || !normalized.apiBaseUrl) {
    return { ok: false, error: 'Host and API base URL are required.' }
  }
  const token = draft.token.trim()
  if (!token) {
    return { ok: false, error: 'A token is required to test the connection.' }
  }
  return verifyServer({ id: 'test', ...normalized }, token)
}

async function statusForServer(server: CustomGitServer): Promise<CustomGitServerStatus> {
  const base: Omit<CustomGitServerStatus, 'authenticated' | 'account'> = {
    id: server.id,
    name: server.name,
    host: server.host,
    apiBaseUrl: server.apiBaseUrl,
    apiFlavor: server.apiFlavor,
    configured: hasStoredCustomGitServerToken(server.id)
  }
  if (!base.configured) {
    return { ...base, authenticated: false, account: null }
  }
  let token: string | null
  try {
    token = getCustomGitServerToken(server.id)
  } catch {
    // Undecryptable token: configured but not usable.
    return { ...base, authenticated: false, account: null }
  }
  if (!token) {
    return { ...base, authenticated: false, account: null }
  }
  const result = await verifyServerCached(server, token)
  return { ...base, authenticated: result.ok, account: result.ok ? result.account : null }
}

// Reuse a recent verify() for `server` within the TTL; refresh once it expires.
function verifyServerCached(
  server: CustomGitServer,
  token: string
): Promise<CustomGitServerTestResult> {
  const cached = verificationCache.get(server.id)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result
  }
  const result = verifyServer(server, token)
  verificationCache.set(server.id, { expiresAt: Date.now() + STATUS_VERIFY_TTL_MS, result })
  // Don't cache a rejected/failed probe so a transient outage self-heals next tick.
  void result
    .then((outcome) => {
      if (!outcome.ok) {
        invalidateServerVerification(server.id)
      }
    })
    .catch(() => invalidateServerVerification(server.id))
  return result
}

/** Status of every configured server (token presence + live auth check). */
export function getCustomGitServerStatuses(): Promise<CustomGitServerStatus[]> {
  return Promise.all(listCustomGitServers().map((server) => statusForServer(server)))
}
