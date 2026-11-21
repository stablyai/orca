import { taskProviderFailure } from '../../shared/work-items/task-provider-failure'
import { CredentialDecryptionError } from '../credentials/integration-credential-file'
import type {
  JiraConnectArgs,
  JiraConnectionStatus,
  JiraSite,
  JiraSiteSelection,
  JiraViewer
} from '../../shared/jira/jira-types'
import { clearAttachmentImagesForSite } from './attachments/image-cache'
import { acquire, release } from './request-queue'
import {
  getCredentialError,
  deleteToken,
  getSiteFile,
  inSiteRegistryOrder,
  hasStoredToken,
  readToken,
  saveToken,
  writeSiteFile,
  getSiteTokenProtection
} from './site-credential-store'
import {
  apiBasePath,
  authHeader,
  JiraApiError,
  jiraRequest,
  type JiraClientForSite
} from './authenticated-request'
import {
  getSiteId,
  normalizeJiraSiteUrl,
  resolveJiraAuthType,
  siteToViewer,
  toViewer
} from './site-identity'
import { verifyJiraCredentials } from './credential-verification'

export async function getClients(
  selection?: JiraSiteSelection | null
): Promise<JiraClientForSite[]> {
  // Reconnect saves the token before the site record; the registry queue keeps each client's pair from one generation.
  return inSiteRegistryOrder(() => readClients(selection))
}

async function readClients(
  selection: JiraSiteSelection | null | undefined
): Promise<JiraClientForSite[]> {
  const file = await getSiteFile()
  const selected = selection ?? file.selectedSiteId ?? file.activeSiteId
  const isAllSelection = selected === 'all'
  const sites = isAllSelection
    ? file.sites
    : file.sites.filter((site) => site.id === (selected ?? file.activeSiteId))

  const clients = await Promise.all(
    sites.map(async (site) => {
      let token: string | null
      try {
        token = await readToken(site.id)
      } catch (error) {
        // For all-sites reads, skip unreadable credentials; explicit site reads still throw and status retains the error.
        if (isAllSelection && error instanceof CredentialDecryptionError) {
          return []
        }
        throw error
      }
      return token ? [{ site, authorization: authHeader(site.email, token, site.authType) }] : []
    })
  )
  return clients.flat()
}

export async function getStatus(): Promise<JiraConnectionStatus> {
  const file = await getSiteFile()
  const presence = await Promise.all(file.sites.map((site) => hasStoredToken(site.id)))
  const sites = file.sites.filter((_, index) => presence[index])
  const activeSite = sites.find((site) => site.id === file.activeSiteId) ?? sites[0] ?? null
  const credentialError = (
    await Promise.all(sites.map((site) => getCredentialError(site.id)))
  ).find((message) => message !== undefined)
  let credentialProtection: 'plaintext' | null = null
  for (const site of sites) {
    if ((await getSiteTokenProtection(site.id)) === 'plaintext') {
      credentialProtection = 'plaintext'
      break
    }
  }
  return {
    connected: sites.length > 0,
    viewer: siteToViewer(activeSite),
    sites,
    activeSiteId: activeSite?.id ?? null,
    selectedSiteId: file.selectedSiteId ?? activeSite?.id ?? null,
    ...(credentialError ? { credentialError } : {}),
    credentialProtection,
    supportsScopedTokens: true
  }
}

export async function connect(
  args: JiraConnectArgs
): Promise<{ ok: true; viewer: JiraViewer } | { ok: false; error: string }> {
  let siteUrl: string
  try {
    siteUrl = normalizeJiraSiteUrl(args.siteUrl)
  } catch {
    return taskProviderFailure('jira.invalidSiteUrl', 'Enter a valid Jira site URL.')
  }

  const authType = resolveJiraAuthType(siteUrl, args.authType)
  const email = args.email.trim()
  const apiToken = args.apiToken.trim()
  if (authType === 'server') {
    if (!apiToken) {
      // A username present means classic Basic auth (password); its absence
      // means the credential is a personal access token sent as Bearer.
      return email
        ? taskProviderFailure('jira.passwordRequired', 'Password is required.')
        : taskProviderFailure('jira.personalTokenRequired', 'Personal access token is required.')
    }
  } else if (!apiToken) {
    return taskProviderFailure('jira.apiTokenRequired', 'API token is required.')
  }

  await acquire()
  try {
    const { viewer, apiBaseUrl } = await verifyJiraCredentials(siteUrl, email, apiToken, authType)
    // PAT sites lack email; verified viewer identity prevents same-host account collisions.
    const id = getSiteId(siteUrl, email || viewer.accountId)
    const site: JiraSite = {
      id,
      siteUrl,
      email,
      displayName: viewer.displayName,
      accountId: viewer.accountId,
      authType,
      ...(apiBaseUrl ? { apiBaseUrl } : {})
    }
    await inSiteRegistryOrder(async () => {
      clearAttachmentImagesForSite(id)
      await saveToken(id, apiToken)
      const file = await getSiteFile()
      await writeSiteFile({
        version: 1,
        activeSiteId: id,
        selectedSiteId: id,
        sites: [site, ...file.sites.filter((entry) => entry.id !== id)]
      })
    })
    return { ok: true, viewer }
  } catch (error) {
    return error instanceof Error
      ? { ok: false, error: error.message }
      : taskProviderFailure('jira.connectionFailed', 'Connection failed.')
  } finally {
    release()
  }
}

export async function disconnect(siteId?: string): Promise<void> {
  await inSiteRegistryOrder(async () => {
    const file = await getSiteFile()
    const ids = siteId ? [siteId] : file.sites.map((site) => site.id)
    for (const id of ids) {
      await deleteToken(id)
    }
    clearAttachmentImagesForSite(siteId)
    await writeSiteFile({
      version: 1,
      activeSiteId: file.activeSiteId,
      selectedSiteId: file.selectedSiteId,
      sites: file.sites.filter((site) => !ids.includes(site.id))
    })
  })
}

export async function selectSite(siteId: JiraSiteSelection): Promise<JiraConnectionStatus> {
  return inSiteRegistryOrder(async () => {
    const file = await getSiteFile()
    if (siteId !== 'all' && !file.sites.some((site) => site.id === siteId)) {
      return getStatus()
    }
    await writeSiteFile({
      ...file,
      activeSiteId: siteId === 'all' ? file.activeSiteId : siteId,
      selectedSiteId: siteId
    })
    return getStatus()
  })
}

export async function testConnection(
  siteId?: string
): Promise<{ ok: true; viewer: JiraViewer } | { ok: false; error: string }> {
  let client: JiraClientForSite | undefined
  try {
    client = (await getClients(siteId))[0]
  } catch (error) {
    return error instanceof Error
      ? { ok: false, error: error.message }
      : taskProviderFailure('jira.connectionFailed', 'Connection failed.')
  }
  if (!client) {
    return taskProviderFailure('jira.notConnected', 'Not connected to Jira.')
  }
  await acquire()
  try {
    const viewer = toViewer(
      (await jiraRequest(client, `${apiBasePath(client.site)}/myself`)) as Record<string, unknown>,
      client.site.email
    )
    return { ok: true, viewer }
  } catch (error) {
    return error instanceof Error
      ? { ok: false, error: error.message }
      : taskProviderFailure('jira.connectionFailed', 'Connection failed.')
  } finally {
    release()
  }
}

export async function clearToken(failedClient: JiraClientForSite): Promise<void> {
  await inSiteRegistryOrder(async () => {
    const siteId = failedClient.site.id
    let currentClient: JiraClientForSite | undefined
    try {
      currentClient = (await readClients(siteId))[0]
    } catch (error) {
      if (error instanceof CredentialDecryptionError) {
        return
      }
      throw error
    }
    if (!currentClient || currentClient.authorization !== failedClient.authorization) {
      return
    }
    await deleteToken(siteId)
    clearAttachmentImagesForSite(siteId)
    const file = await getSiteFile()
    await writeSiteFile({ ...file, sites: file.sites.filter((site) => site.id !== siteId) })
  })
}

export function isAuthError(error: unknown): boolean {
  // Jira 403 may mean missing project permissions; only an unscoped 401 invalidates the credential.
  return error instanceof JiraApiError && error.status === 401 && !error.scopeMismatch
}
