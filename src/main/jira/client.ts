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
import { resolveJiraGatewayBaseUrl } from './cloud-gateway'
import { normalizeJiraAuthType } from '../../shared/jira-auth-type'

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

type VerifiedCredentials = {
  viewer: Record<string, unknown>
  authType: JiraAuthType
  apiBaseUrl?: string
}

async function verifyCredentials(
  siteUrl: string,
  email: string,
  apiToken: string,
  authType: JiraAuthType
): Promise<VerifiedCredentials> {
  if (authType === 'cloud-scoped') {
    // Why: scoped tokens are rejected on the site host with a bare 401, so the
    // gateway URL is resolved up front and stored alongside the site.
    const apiBaseUrl = await resolveJiraGatewayBaseUrl(siteUrl)
    const viewer = await requestWithCredentials(
      apiBaseUrl,
      email,
      apiToken,
      '/rest/api/3/myself',
      undefined,
      authType
    )
    return { viewer: viewer as Record<string, unknown>, authType, apiBaseUrl }
  }
  const myselfPath = authType === 'server' ? '/rest/api/2/myself' : '/rest/api/3/myself'
  try {
    const viewer = await requestWithCredentials(
      siteUrl,
      email,
      apiToken,
      myselfPath,
      undefined,
      authType
    )
    return { viewer: viewer as Record<string, unknown>, authType }
  } catch (siteError) {
    if (authType !== 'cloud' || !(siteError instanceof JiraApiError) || siteError.status !== 401) {
      throw siteError
    }
    // Why: a scoped token looks like any other Cloud API token to the user, so
    // instead of asking which kind it is, a site-host 401 retries on the gateway.
    try {
      return await verifyCredentials(siteUrl, email, apiToken, 'cloud-scoped')
    } catch (gatewayError) {
      // A scope gap proves the token is scoped; otherwise the site verdict is clearer.
      throw gatewayError instanceof JiraApiError && gatewayError.scopeMismatch
        ? gatewayError
        : siteError
    }
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

  const authType: JiraAuthType = normalizeJiraAuthType(args.authType)
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
  } else if (authType === 'cloud-scoped') {
    // The email is optional here: it only switches Bearer to Basic.
    if (!apiToken) {
      return { ok: false, error: 'Scoped API token is required.' }
    }
  } else if (!email || !apiToken) {
    return { ok: false, error: 'Email and API token are required.' }
  }

  await acquire()
  try {
    const verified = await verifyCredentials(siteUrl, email, apiToken, authType)
    const { apiBaseUrl } = verified
    const viewer = toViewer(verified.viewer, email || siteUrl)
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
      authType: verified.authType,
      ...(apiBaseUrl ? { apiBaseUrl } : {})
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
  // succeeds, so only 401 means the saved credential itself is invalid. The
  // api.atlassian.com gateway also answers 401 when a scoped token lacks one
  // endpoint's scope; that token still works elsewhere, so it is not revoked.
  return error instanceof JiraApiError && error.status === 401 && !error.scopeMismatch
}
