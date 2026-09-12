import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  loadProjectId,
  readAuthJson,
  readAntigravityCredentials,
  readAntigravityKeychainCredentials,
  saveAntigravityCredentials,
  tryRefreshTokenFromBundle,
  type AntigravityCredentials,
  type GoogleAuthEntry
} from './antigravity-oauth-sources'
import { fetchAntigravityQuota } from './antigravity-quota-client'
import { fetchManagedAccountsAggregate } from './antigravity-managed-account-fetch'

async function fetchViaAuthJson(
  auth: GoogleAuthEntry,
  antigravityCliOAuthEnabled = false
): Promise<ProviderRateLimits> {
  let accessToken = auth.access
  const refreshToken = (auth.refresh || '').split('|')[0] ?? ''
  if (auth.expires < Date.now() || !accessToken) {
    const refreshResult = await tryRefreshTokenFromBundle(refreshToken, antigravityCliOAuthEnabled)
    if (!refreshResult?.accessToken) {
      return {
        provider: 'antigravity',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'Token refresh failed',
        status: 'error'
      }
    }
    accessToken = refreshResult.accessToken
  }
  let effectiveProjectId = ''
  try {
    effectiveProjectId = await loadProjectId(accessToken)
  } catch {
    effectiveProjectId =
      (auth.refresh || '').split('|')[1] || (auth.refresh || '').split('|')[2] || ''
  }
  if (!effectiveProjectId) {
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Antigravity project ID not found',
      status: 'error'
    }
  }
  const result = await fetchAntigravityQuota(accessToken, effectiveProjectId)
  if (result.status === 'error' && result.error?.includes('401')) {
    const refreshResult = await tryRefreshTokenFromBundle(refreshToken, antigravityCliOAuthEnabled)
    if (refreshResult?.accessToken) {
      const newProjectId = await loadProjectId(refreshResult.accessToken).catch(() => {
        return effectiveProjectId
      })
      return fetchAntigravityQuota(refreshResult.accessToken, newProjectId)
    }
  }
  return result
}

async function fetchViaOauthCreds(
  creds: AntigravityCredentials,
  antigravityCliOAuthEnabled = false
): Promise<ProviderRateLimits> {
  let accessToken = creds.access_token
  let currentCreds = creds
  if (creds.expiry_date < Date.now()) {
    // Why: keychain tokens belong to the agy CLI's OAuth client; refreshing
    // them with the Gemini CLI bundle credentials would always fail. The CLI
    // refreshes the keychain entry itself, so surface a clear error instead.
    const refreshResult =
      creds.source === 'keychain'
        ? null
        : await tryRefreshTokenFromBundle(creds.refresh_token, antigravityCliOAuthEnabled)
    if (!refreshResult?.accessToken) {
      return {
        provider: 'antigravity',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error:
          creds.source === 'keychain'
            ? 'Antigravity token expired — run agy in your terminal to refresh it, then retry'
            : 'Token refresh failed',
        status: 'error'
      }
    }
    accessToken = refreshResult.accessToken
    currentCreds = {
      ...creds,
      access_token: accessToken,
      expiry_date: refreshResult.expiresIn
        ? Date.now() + refreshResult.expiresIn * 1000
        : creds.expiry_date
    }
    await saveAntigravityCredentials(currentCreds)
  }
  const projectId = await loadProjectId(accessToken).catch(() => {
    return ''
  })
  if (!projectId) {
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Antigravity project ID not found',
      status: 'error'
    }
  }
  const result = await fetchAntigravityQuota(accessToken, projectId)
  if (result.status === 'error' && result.error?.includes('401')) {
    const refreshResult = await tryRefreshTokenFromBundle(
      currentCreds.refresh_token,
      antigravityCliOAuthEnabled
    )
    if (refreshResult?.accessToken) {
      const newProjectId = await loadProjectId(refreshResult.accessToken).catch(() => {
        return ''
      })
      if (newProjectId) {
        await saveAntigravityCredentials({
          ...currentCreds,
          access_token: refreshResult.accessToken,
          expiry_date: refreshResult.expiresIn
            ? Date.now() + refreshResult.expiresIn * 1000
            : currentCreds.expiry_date
        })
        return fetchAntigravityQuota(refreshResult.accessToken, newProjectId)
      }
    }
  }
  return result
}

export async function fetchAntigravityRateLimits(
  antigravityCliOAuthEnabled = false
): Promise<ProviderRateLimits> {
  if (!antigravityCliOAuthEnabled) {
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Antigravity CLI OAuth is disabled in settings',
      status: 'unavailable'
    }
  }

  try {
    // Why: Orca-managed OAuth accounts (sub2api-style multi-account) come
    // first; the agy CLI's keychain token and the legacy files remain the
    // single-account fallbacks.
    const managed = await fetchManagedAccountsAggregate()
    if (managed) {
      return managed
    }
    // Why: prefer the freshest credential that actually works. The agy CLI's
    // keychain token is minted by the current Antigravity client; OpenCode's
    // auth.json and the legacy oauth_creds.json files carry Gemini-CLI-era
    // tokens that cloudcode-pa now rejects with 403.
    const keychainCreds = await readAntigravityKeychainCredentials()
    if (keychainCreds) {
      return await fetchViaOauthCreds(keychainCreds, antigravityCliOAuthEnabled)
    }
    const authJson = await readAuthJson()
    const result =
      authJson?.google?.type === 'oauth'
        ? await fetchViaAuthJson(authJson.google, antigravityCliOAuthEnabled)
        : await (async () => {
            const creds = await readAntigravityCredentials()
            return !creds
              ? ({
                  provider: 'antigravity',
                  session: null,
                  weekly: null,
                  updatedAt: Date.now(),
                  error: 'Antigravity CLI credentials not found',
                  status: 'unavailable'
                } as ProviderRateLimits)
              : await fetchViaOauthCreds(creds, antigravityCliOAuthEnabled)
          })()
    return result
  } catch (err) {
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: err instanceof Error ? err.message : 'Unknown error',
      status: 'error'
    }
  }
}
