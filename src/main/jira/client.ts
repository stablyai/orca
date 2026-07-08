import { createHash } from 'node:crypto'
import { CredentialDecryptionError } from '../integration-credential-file'
import type {
  JiraConnectArgs,
  JiraConnectionStatus,
  JiraSite,
  JiraSiteSelection,
  JiraViewer
} from '../../shared/types'
import { basicAuthHeader, jiraAuthorizationHeader } from './auth-headers'
import {
  JiraApiError,
  JIRA_HTTPS_REQUIRED_MESSAGE,
  jiraRequest,
  jiraRequestWithAuthorization,
  type JiraClientForSite
} from './jira-request'
import {
  deleteJiraSiteSecret,
  getJiraCredentialError,
  getSiteFile,
  readJiraSiteSecret,
  saveJiraSiteSecret,
  writeSiteFile
} from './site-storage'
import { jiraSiteToViewer, toCloudJiraViewer, toServerJiraViewer } from './jira-user-identity'
import { normalizeJiraSiteUrl } from './jira-site-url'

export { JiraApiError, jiraRequest, type JiraClientForSite } from './jira-request'
export { normalizeJiraSiteUrl } from './jira-site-url'

const MAX_CONCURRENT = 4
let running = 0
const queue: (() => void)[] = []

export function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1
    return Promise.resolve()
  }
  return new Promise((resolve) =>
    queue.push(() => {
      running += 1
      resolve()
    })
  )
}

export function release(): void {
  running -= 1
  const next = queue.shift()
  if (next) {
    next()
  }
}

function getSiteId(siteUrl: string, email: string): string {
  return createHash('sha256')
    .update(`${siteUrl}\n${email.toLowerCase()}`)
    .digest('base64url')
    .slice(0, 24)
}

function getServerSiteId(siteUrl: string, viewerIdentityId: string): string {
  return createHash('sha256')
    .update(`${siteUrl}\nserver\n${viewerIdentityId}`)
    .digest('base64url')
    .slice(0, 24)
}

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
      token = readJiraSiteSecret(site.id)
    } catch (error) {
      // Why: under an 'all' selection one un-decryptable site must not collapse
      // reads for the healthy ones. readJiraSiteSecret already recorded the per-site
      // credentialError for getStatus to surface, so skip this site like a
      // missing token. A specific-site selection still rethrows so the renderer
      // can surface the decrypt banner promptly.
      if (isAllSelection && error instanceof CredentialDecryptionError) {
        return []
      }
      throw error
    }
    return token ? [{ site, authorization: jiraAuthorizationHeader(site, token) }] : []
  })
}

export function getStatus(): JiraConnectionStatus {
  const file = getSiteFile()
  const sites = file.sites
  const activeSite = sites.find((site) => site.id === file.activeSiteId) ?? sites[0] ?? null
  const credentialError = sites
    .map((site) => getJiraCredentialError(site.id))
    .find((message) => message !== undefined)
  return {
    connected: sites.length > 0,
    viewer: jiraSiteToViewer(activeSite),
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
  if (new URL(siteUrl).protocol !== 'https:') {
    return { ok: false, error: JIRA_HTTPS_REQUIRED_MESSAGE }
  }

  await acquire()
  try {
    let viewer: JiraViewer
    let site: JiraSite
    let secret: string
    if (args.deploymentType === 'server') {
      const authMode = args.authMode
      const username = authMode === 'basic' ? args.username.trim() : ''
      secret = authMode === 'basic' ? args.passwordOrToken.trim() : args.bearerToken.trim()
      if ((authMode === 'basic' && !username) || !secret) {
        return { ok: false, error: 'Jira Server credentials are required.' }
      }
      const authorization =
        authMode === 'bearer' ? `Bearer ${secret}` : basicAuthHeader(username, secret)
      viewer = toServerJiraViewer(
        (await jiraRequestWithAuthorization(
          siteUrl,
          authorization,
          '/rest/api/2/myself'
        )) as Record<string, unknown>,
        username
      )
      if (!viewer.userId) {
        return { ok: false, error: 'Jira Server returned no stable user identity.' }
      }
      const id = getServerSiteId(siteUrl, viewer.userId)
      site = {
        id,
        siteUrl,
        // Why: bearer auth collects no username, so use the stable Server/DC
        // user id instead of persisting a blank renderer compatibility field.
        email: viewer.email ?? (username || viewer.userId),
        displayName: viewer.displayName,
        accountId: viewer.accountId,
        viewerUserId: viewer.userId,
        deploymentType: 'server',
        authMode,
        authUsername: username || viewer.userId
      }
    } else {
      const email = args.email.trim()
      secret = args.apiToken.trim()
      if (!email || !secret) {
        return { ok: false, error: 'Email and API token are required.' }
      }
      viewer = toCloudJiraViewer(
        (await jiraRequestWithAuthorization(
          siteUrl,
          basicAuthHeader(email, secret),
          '/rest/api/3/myself'
        )) as Record<string, unknown>,
        email
      )
      const id = getSiteId(siteUrl, email)
      site = {
        id,
        siteUrl,
        email,
        displayName: viewer.displayName,
        accountId: viewer.accountId,
        viewerUserId: viewer.userId,
        deploymentType: 'cloud',
        authMode: 'basic'
      }
    }
    const file = getSiteFile()
    const wasExistingSite = file.sites.some((entry) => entry.id === site.id)
    saveJiraSiteSecret(site.id, secret)
    try {
      writeSiteFile({
        version: 1,
        activeSiteId: site.id,
        selectedSiteId: site.id,
        sites: [site, ...file.sites.filter((entry) => entry.id !== site.id)]
      })
    } catch (error) {
      if (!wasExistingSite) {
        deleteJiraSiteSecret(site.id)
      }
      throw error
    }
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
    deleteJiraSiteSecret(id)
  }
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
    const rawViewer = (await jiraRequest(
      client,
      client.site.deploymentType === 'server' ? '/rest/api/2/myself' : '/rest/api/3/myself'
    )) as Record<string, unknown>
    const viewer =
      client.site.deploymentType === 'server'
        ? toServerJiraViewer(rawViewer, client.site.authUsername ?? client.site.email)
        : toCloudJiraViewer(rawViewer, client.site.email)
    return { ok: true, viewer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function clearToken(siteId: string): void {
  deleteJiraSiteSecret(siteId)
  const file = getSiteFile()
  writeSiteFile({ ...file, sites: file.sites.filter((site) => site.id !== siteId) })
}

export function isAuthError(error: unknown): boolean {
  // Why: Jira returns 403 for project/API permission gaps even when /myself
  // succeeds, so only 401 means the saved credential itself is invalid.
  return error instanceof JiraApiError && error.status === 401
}
