import { CredentialDecryptionError } from '../integration-credential-file'
import type {
  MantisBTConnectArgs,
  MantisBTConnectionStatus,
  MantisBTSite,
  MantisBTSiteSelection,
  MantisBTViewer
} from '../../shared/mantisbt-types'
import { acquire, release } from './request-queue'
import {
  credentialErrors,
  deleteToken,
  getSiteFile,
  hasStoredToken,
  readToken,
  saveToken,
  writeSiteFile
} from './site-credential-store'
import {
  apiBasePath,
  authHeader,
  MantisBTApiError,
  mantisBTRequest,
  probeMantisBTConnection,
  type MantisBTClientForSite
} from './authenticated-request'
import { getSiteId, normalizeMantisBTSiteUrl, siteToViewer, toViewer } from './site-identity'

export function getClients(selection?: MantisBTSiteSelection | null): MantisBTClientForSite[] {
  const file = getSiteFile()
  const selected = selection ?? file.selectedSiteId ?? file.activeSiteId
  const isAllSelection = selected === 'all'
  const sites = isAllSelection
    ? file.sites
    : file.sites.filter((site) => site.id === (selected ?? file.activeSiteId))

  return sites.flatMap((site) => {
    let token: string | null
    try {
      token = readToken(site.id)
    } catch (error) {
      // Why: under an 'all' selection one un-decryptable site must not collapse
      // reads for the healthy ones. readToken already recorded the per-site
      // credentialError for getStatus to surface, so skip this site like a
      // missing token. A specific-site selection still rethrows so the renderer
      // can surface the decrypt banner promptly.
      if (isAllSelection && error instanceof CredentialDecryptionError) {
        return []
      }
      throw error
    }
    return token ? [{ site, authorization: authHeader(token, site.authScheme) }] : []
  })
}

export function getStatus(): MantisBTConnectionStatus {
  const file = getSiteFile()
  const sites = file.sites.filter((site) => hasStoredToken(site.id))
  const activeSite = sites.find((site) => site.id === file.activeSiteId) ?? sites[0] ?? null
  const credentialError = sites
    .map((site) => credentialErrors.get(site.id))
    .find((message) => message !== undefined)
  return {
    connected: sites.length > 0,
    viewer: siteToViewer(activeSite),
    sites,
    activeSiteId: activeSite?.id ?? null,
    selectedSiteId: file.selectedSiteId ?? activeSite?.id ?? null,
    ...(credentialError ? { credentialError } : {})
  }
}

export async function connect(
  args: MantisBTConnectArgs
): Promise<{ ok: true; viewer: MantisBTViewer } | { ok: false; error: string }> {
  let siteUrl: string
  try {
    siteUrl = normalizeMantisBTSiteUrl(args.siteUrl)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Enter a valid MantisBT site URL.'
    }
  }

  const apiToken = args.apiToken.trim()
  if (!apiToken) {
    return { ok: false, error: 'API token is required.' }
  }

  await acquire()
  try {
    const probe = await probeMantisBTConnection(siteUrl, apiToken)
    const viewer = toViewer(probe.data)
    const id = getSiteId(siteUrl, viewer.id)
    const site: MantisBTSite = {
      id,
      siteUrl,
      userId: viewer.id,
      displayName: viewer.displayName,
      authScheme: probe.authScheme,
      usePhpIndexPath: probe.usePhpIndexPath
    }
    saveToken(id, apiToken)
    const file = getSiteFile()
    writeSiteFile({
      version: 1,
      activeSiteId: id,
      selectedSiteId: id,
      sites: [site, ...file.sites.filter((entry) => entry.id !== id)]
    })
    return { ok: true, viewer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function disconnect(siteId?: string): void {
  const file = getSiteFile()
  const ids = siteId ? [siteId] : file.sites.map((site) => site.id)
  const removed: string[] = []
  let firstFailure: unknown
  for (const id of ids) {
    try {
      deleteToken(id)
      removed.push(id)
    } catch (error) {
      firstFailure ??= error
    }
  }
  writeSiteFile({
    version: 1,
    activeSiteId: file.activeSiteId,
    selectedSiteId: file.selectedSiteId,
    sites: file.sites.filter((site) => !removed.includes(site.id))
  })
  // Why: a token-file deletion failure must not look like a successful
  // disconnect (CWE-459) — the site file above still reflects the sites that
  // really were removed, but the caller learns the operation was incomplete.
  if (firstFailure !== undefined) {
    throw firstFailure instanceof Error
      ? firstFailure
      : new Error('Failed to remove one or more MantisBT credentials.')
  }
}

export function selectSite(siteId: MantisBTSiteSelection): MantisBTConnectionStatus {
  const file = getSiteFile()
  if (siteId !== 'all' && !file.sites.some((site) => site.id === siteId)) {
    return getStatus()
  }
  writeSiteFile({
    ...file,
    activeSiteId: siteId === 'all' ? file.activeSiteId : siteId,
    selectedSiteId: siteId
  })
  return getStatus()
}

export async function testConnection(
  siteId?: string
): Promise<{ ok: true; viewer: MantisBTViewer } | { ok: false; error: string }> {
  let client: MantisBTClientForSite | undefined
  try {
    client = getClients(siteId)[0]
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  }
  if (!client) {
    return { ok: false, error: 'Not connected to MantisBT.' }
  }
  await acquire()
  try {
    const viewer = toViewer(
      await mantisBTRequest(client, `${apiBasePath(client.site.usePhpIndexPath)}/users/me`)
    )
    return { ok: true, viewer }
  } catch (error) {
    if (isAuthError(error)) {
      try {
        clearToken(client.site.id)
      } catch (evictionError) {
        console.warn('[mantisBT] failed to evict invalid token:', evictionError)
      }
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function clearToken(siteId: string): void {
  deleteToken(siteId)
  const file = getSiteFile()
  writeSiteFile({ ...file, sites: file.sites.filter((site) => site.id !== siteId) })
}

export function isAuthError(error: unknown): boolean {
  return error instanceof MantisBTApiError && error.status === 401
}
