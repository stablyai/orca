import { createHash } from 'node:crypto'
import { CredentialDecryptionError } from '../integration-credential-file'
import type {
  BusinessmapConnectArgs,
  BusinessmapConnectionStatus,
  BusinessmapDomain,
  BusinessmapSite,
  BusinessmapViewer
} from '../../shared/businessmap-types'
import { acquire, release } from './request-queue'
import {
  BUSINESSMAP_SUBDOMAIN_PATTERN,
  asRecord,
  asString,
  isAuthError,
  requestWithCredentials,
  unwrapSingle
} from './authenticated-request'
import {
  credentialErrors,
  deleteToken,
  getSiteFile,
  hasStoredToken,
  readToken,
  saveToken,
  writeSiteFile
} from './site-credential-store'

export function getSiteId(subdomain: string, domain: BusinessmapDomain): string {
  return createHash('sha256')
    .update(`${subdomain.toLowerCase()}\n${domain}`)
    .digest('base64url')
    .slice(0, 24)
}

function normalizeDomain(value: unknown): BusinessmapDomain {
  return value === 'kanbanize.com' ? 'kanbanize.com' : 'businessmap.io'
}

export function toViewer(data: Record<string, unknown>, subdomain: string): BusinessmapViewer {
  return {
    displayName: asString(data.realname) || asString(data.email) || subdomain,
    subdomain
  }
}

function siteToViewer(site: BusinessmapSite | null): BusinessmapViewer | null {
  if (!site) {
    return null
  }
  return { displayName: site.displayName ?? site.subdomain, subdomain: site.subdomain }
}

export function getClients(siteId?: string | null): { site: BusinessmapSite; apiKey: string }[] {
  const file = getSiteFile()
  const selected = siteId ?? file.selectedSiteId ?? file.activeSiteId
  const sites = selected ? file.sites.filter((site) => site.id === selected) : file.sites
  return sites.flatMap((site) => {
    let token: string | null
    try {
      token = readToken(site.id)
    } catch (error) {
      // Why: one un-decryptable site must not collapse reads for the other
      // sites. readToken already recorded the per-site credentialError for
      // getStatus to surface. A specific-site selection still rethrows so the
      // renderer can surface the decrypt banner promptly.
      if (!selected && error instanceof CredentialDecryptionError) {
        return []
      }
      throw error
    }
    return token ? [{ site, apiKey: token }] : []
  })
}

export function getStatus(): BusinessmapConnectionStatus {
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
  args: BusinessmapConnectArgs
): Promise<{ ok: true; viewer: BusinessmapViewer } | { ok: false; error: string }> {
  const subdomain = args.subdomain.trim().toLowerCase()
  if (!BUSINESSMAP_SUBDOMAIN_PATTERN.test(subdomain)) {
    return { ok: false, error: 'Enter a valid Businessmap subdomain.' }
  }
  const apiKey = args.apiKey.trim()
  if (!apiKey) {
    return { ok: false, error: 'API key is required.' }
  }
  const domain = normalizeDomain(args.domain)
  await acquire()
  try {
    const site: BusinessmapSite = { id: '', subdomain, domain }
    site.id = getSiteId(subdomain, domain)
    const me = unwrapSingle(await requestWithCredentials(site, apiKey, '/me'))
    const viewer = toViewer(asRecord(me), subdomain)
    const stored: BusinessmapSite = {
      id: site.id,
      subdomain,
      domain,
      displayName: viewer.displayName,
      ...(asString(me.email) ? { accountName: asString(me.email) } : {})
    }
    saveToken(site.id, apiKey)
    const file = getSiteFile()
    writeSiteFile({
      version: 1,
      activeSiteId: site.id,
      selectedSiteId: site.id,
      sites: [stored, ...file.sites.filter((entry) => entry.id !== site.id)]
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
  for (const id of ids) {
    deleteToken(id)
  }
  writeSiteFile({
    version: 1,
    activeSiteId: file.activeSiteId,
    selectedSiteId: file.selectedSiteId,
    sites: file.sites.filter((site) => !ids.includes(site.id))
  })
}

export function selectSite(siteId: string): BusinessmapConnectionStatus {
  const file = getSiteFile()
  if (!file.sites.some((site) => site.id === siteId)) {
    return getStatus()
  }
  writeSiteFile({ ...file, activeSiteId: siteId, selectedSiteId: siteId })
  return getStatus()
}

export async function testConnection(
  siteId?: string
): Promise<{ ok: true; viewer: BusinessmapViewer } | { ok: false; error: string }> {
  let client: { site: BusinessmapSite; apiKey: string } | undefined
  try {
    client = getClients(siteId)[0]
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  }
  if (!client) {
    return { ok: false, error: 'Not connected to Businessmap.' }
  }
  await acquire()
  try {
    const me = unwrapSingle(await requestWithCredentials(client.site, client.apiKey, '/me'))
    return { ok: true, viewer: toViewer(asRecord(me), client.site.subdomain) }
  } catch (error) {
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

export { isAuthError }
