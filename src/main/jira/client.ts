import { CredentialDecryptionError } from '../integration-credential-file'
import type {
  JiraAuthType,
  JiraConnectArgs,
  JiraConnectionStatus,
  JiraSite,
  JiraSiteSelection,
  JiraViewer
} from '../../shared/jira-types'
import { clearAttachmentImagesForSite } from './attachment-image-cache'
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
  JiraApiError,
  jiraRequest,
  requestWithCredentials,
  type JiraClientForSite
} from './authenticated-request'
import { getSiteId, normalizeJiraSiteUrl, siteToViewer, toViewer } from './site-identity'

export function getClients(selection?: JiraSiteSelection | null): JiraClientForSite[] {
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
    return token ? [{ site, authorization: authHeader(site.email, token, site.authType) }] : []
  })
}

export function getStatus(): JiraConnectionStatus {
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
  args: JiraConnectArgs
): Promise<{ ok: true; viewer: JiraViewer } | { ok: false; error: string }> {
  let siteUrl: string
  try {
    siteUrl = normalizeJiraSiteUrl(args.siteUrl)
  } catch {
    return { ok: false, error: 'Enter a valid Jira site URL.' }
  }

  const authType: JiraAuthType = args.authType === 'server' ? 'server' : 'cloud'
  const email = args.email.trim()
  const apiToken = args.apiToken.trim()
  if (authType === 'server') {
    if (!apiToken) {
      // A username present means classic Basic auth (password); its absence
      // means the credential is a personal access token sent as Bearer.
      return {
        ok: false,
        error: email ? 'Password is required.' : 'Personal access token is required.'
      }
    }
  } else if (!email || !apiToken) {
    return { ok: false, error: 'Email and API token are required.' }
  }

  await acquire()
  try {
    const myselfPath = authType === 'server' ? '/rest/api/2/myself' : '/rest/api/3/myself'
    const viewer = toViewer(
      (await requestWithCredentials(
        siteUrl,
        email,
        apiToken,
        myselfPath,
        undefined,
        authType
      )) as Record<string, unknown>,
      email || siteUrl
    )
    // PAT sites have no email, so keying on it alone would collide every PAT
    // connection to the same host into one id (silently overwriting a prior
    // account + token). Fall back to the verified viewer identity so distinct
    // accounts stay distinct. Cloud/Basic keep keying on their non-empty email.
    const id = getSiteId(siteUrl, email || viewer.accountId)
    const site: JiraSite = {
      id,
      siteUrl,
      email,
      displayName: viewer.displayName,
      accountId: viewer.accountId,
      authType
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
  for (const id of ids) {
    deleteToken(id)
  }
  // Why: drop cached attachment data URLs for disconnected sites so main does
  // not retain multi-MB strings after logout.
  clearAttachmentImagesForSite(siteId)
  writeSiteFile({
    version: 1,
    activeSiteId: file.activeSiteId,
    selectedSiteId: file.selectedSiteId,
    sites: file.sites.filter((site) => !ids.includes(site.id))
  })
}

export function selectSite(siteId: JiraSiteSelection): JiraConnectionStatus {
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
): Promise<{ ok: true; viewer: JiraViewer } | { ok: false; error: string }> {
  let client: JiraClientForSite | undefined
  try {
    client = getClients(siteId)[0]
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  }
  if (!client) {
    return { ok: false, error: 'Not connected to Jira.' }
  }
  await acquire()
  try {
    const viewer = toViewer(
      (await jiraRequest(client, `${apiBasePath(client.site)}/myself`)) as Record<string, unknown>,
      client.site.email
    )
    return { ok: true, viewer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function clearToken(siteId: string): void {
  deleteToken(siteId)
  // Why: auth failure removes the site; drop cached attachment data URLs too.
  clearAttachmentImagesForSite(siteId)
  const file = getSiteFile()
  writeSiteFile({ ...file, sites: file.sites.filter((site) => site.id !== siteId) })
}

export function isAuthError(error: unknown): boolean {
  // Why: Jira returns 403 for project/API permission gaps even when /myself
  // succeeds, so only 401 means the saved credential itself is invalid.
  return error instanceof JiraApiError && error.status === 401
}
