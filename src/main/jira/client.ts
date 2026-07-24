/* eslint-disable max-lines -- Why: Jira credential storage and authenticated
request plumbing share one boundary so encrypted token lifecycle and
multi-site selection cannot drift between task operations. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { net, safeStorage, session } from 'electron'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readIntegrationCredentialFileSync,
  readIntegrationCredentialFileSyncText,
  readStoredCredentialToken
} from '../integration-credential-file'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { withSpan } from '../observability/tracer'
import { readFetchResponseJsonWithinLimit } from '../lib/fetch-response-body'
import { IntegrationApiConcurrencyGate } from '../integration-api-concurrency'
import {
  assertIntegrationAccountCount,
  assertIntegrationCredentialBytes,
  assertIntegrationStringBytes,
  IntegrationAccountPersistenceLimitError,
  MAX_INTEGRATION_ACCOUNT_EMAIL_BYTES,
  MAX_INTEGRATION_ACCOUNT_FILE_BYTES,
  MAX_INTEGRATION_ACCOUNT_ID_BYTES,
  MAX_INTEGRATION_ACCOUNT_LABEL_BYTES,
  MAX_INTEGRATION_ACCOUNTS,
  MAX_INTEGRATION_ACCOUNT_URL_BYTES,
  serializeIntegrationAccountFile,
  unreadableIntegrationAccountFileError
} from '../integration-account-persistence-limits'
import { boundedIntegrationErrorMessage } from '../integration-error-message'
import type {
  JiraAuthType,
  JiraConnectArgs,
  JiraConnectionStatus,
  JiraSite,
  JiraSiteSelection,
  JiraViewer
} from '../../shared/types'

// Why: Atlassian's XSRF filter rejects POST/PUT REST calls that carry a browser
// User-Agent, failing them with "XSRF check failed" even under API-token auth.
// Electron's net.fetch sends a Chrome UA, so issue search/create/update/comment
// all 403'd while GET calls (connect, /myself) passed. A non-browser UA is the
// reliable fix; X-Atlassian-Token: no-check is not honored for this case.
const JIRA_API_USER_AGENT = 'Orca'

const MAX_CONCURRENT = 4
const concurrencyGate = new IntegrationApiConcurrencyGate(MAX_CONCURRENT)

export function acquire(): Promise<void> {
  return concurrencyGate.acquire()
}

export function release(): void {
  concurrencyGate.release()
}

type JiraSiteFile = {
  version: 1
  activeSiteId: string | null
  selectedSiteId: JiraSiteSelection | null
  sites: JiraSite[]
}

export type JiraClientForSite = {
  site: JiraSite
  authorization: string
}

// Self-hosted Jira Server/Data Center only exposes REST v2; Cloud endpoints
// in this codebase are written against v3. Callers build paths with this
// prefix so one code path serves both deployments.
export function apiBasePath(site: JiraSite): string {
  return site.authType === 'server' ? '/rest/api/2' : '/rest/api/3'
}

export class JiraApiError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(boundedIntegrationErrorMessage(message))
    this.status = status
  }
}

let cachedSiteFile: JiraSiteFile | null = null
let siteFileLoaded = false
let siteFileReadError: Error | null = null
const cachedTokens = new Map<string, string>()
// Why: decrypt failures are recorded per site so getStatus can explain
// failing reads without re-touching the keychain on every status poll.
const credentialErrors = new Map<string, string>()

function cacheToken(siteId: string, token: string): void {
  if (!cachedTokens.has(siteId) && cachedTokens.size >= MAX_INTEGRATION_ACCOUNTS) {
    const oldestSiteId = cachedTokens.keys().next().value
    if (oldestSiteId !== undefined) {
      cachedTokens.delete(oldestSiteId)
    }
  }
  cachedTokens.set(siteId, token)
}

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getSiteFilePath(): string {
  return join(getOrcaDir(), 'jira-sites.json')
}

function getTokenDir(): string {
  return join(getOrcaDir(), 'jira-tokens')
}

function getTokenPath(siteId: string): string {
  assertIntegrationStringBytes('Jira', 'site ID', siteId, MAX_INTEGRATION_ACCOUNT_ID_BYTES)
  return join(getTokenDir(), `${Buffer.from(siteId).toString('base64url')}.enc`)
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function ensureTokenDir(): void {
  const dir = getTokenDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function emptySiteFile(): JiraSiteFile {
  return {
    version: 1,
    activeSiteId: null,
    selectedSiteId: null,
    sites: []
  }
}

function hasStoredToken(siteId: string): boolean {
  return cachedTokens.has(siteId) || credentialFileHasContent(getTokenPath(siteId))
}

function normalizeSite(input: unknown): JiraSite | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.siteUrl !== 'string' ||
    typeof record.email !== 'string' ||
    typeof record.displayName !== 'string' ||
    typeof record.accountId !== 'string'
  ) {
    return null
  }
  return {
    id: record.id,
    siteUrl: record.siteUrl,
    email: record.email,
    displayName: record.displayName,
    accountId: record.accountId,
    // Sites saved before self-hosted support have no authType; they are Cloud.
    authType: record.authType === 'server' ? 'server' : 'cloud'
  }
}

function assertSiteBounds(site: JiraSite): void {
  assertIntegrationStringBytes('Jira', 'site ID', site.id, MAX_INTEGRATION_ACCOUNT_ID_BYTES)
  assertIntegrationStringBytes('Jira', 'site URL', site.siteUrl, MAX_INTEGRATION_ACCOUNT_URL_BYTES)
  assertIntegrationStringBytes('Jira', 'email', site.email, MAX_INTEGRATION_ACCOUNT_EMAIL_BYTES)
  assertIntegrationStringBytes(
    'Jira',
    'display name',
    site.displayName,
    MAX_INTEGRATION_ACCOUNT_LABEL_BYTES
  )
  assertIntegrationStringBytes(
    'Jira',
    'account ID',
    site.accountId,
    MAX_INTEGRATION_ACCOUNT_LABEL_BYTES
  )
}

function assertStoredSiteBounds(input: unknown): void {
  if (!input || typeof input !== 'object') {
    return
  }
  const record = input as Record<string, unknown>
  const fields = [
    ['site ID', record.id, MAX_INTEGRATION_ACCOUNT_ID_BYTES],
    ['site URL', record.siteUrl, MAX_INTEGRATION_ACCOUNT_URL_BYTES],
    ['email', record.email, MAX_INTEGRATION_ACCOUNT_EMAIL_BYTES],
    ['display name', record.displayName, MAX_INTEGRATION_ACCOUNT_LABEL_BYTES],
    ['account ID', record.accountId, MAX_INTEGRATION_ACCOUNT_LABEL_BYTES]
  ] as const
  for (const [field, value, maxBytes] of fields) {
    if (typeof value === 'string') {
      assertIntegrationStringBytes('Jira', field, value, maxBytes)
    }
  }
}

function assertSiteFileBounds(file: JiraSiteFile): void {
  assertIntegrationAccountCount('Jira', file.sites.length)
  for (const site of file.sites) {
    assertSiteBounds(site)
  }
}

function readSiteFileFromDisk(): JiraSiteFile {
  const path = getSiteFilePath()
  if (!existsSync(path)) {
    siteFileReadError = null
    return emptySiteFile()
  }
  try {
    const parsed = JSON.parse(readIntegrationCredentialFileSyncText(path)) as Partial<JiraSiteFile>
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.sites)
    ) {
      throw unreadableIntegrationAccountFileError('Jira')
    }
    if (typeof parsed.activeSiteId === 'string') {
      assertIntegrationStringBytes(
        'Jira',
        'active site ID',
        parsed.activeSiteId,
        MAX_INTEGRATION_ACCOUNT_ID_BYTES
      )
    }
    if (typeof parsed.selectedSiteId === 'string' && parsed.selectedSiteId !== 'all') {
      assertIntegrationStringBytes(
        'Jira',
        'selected site ID',
        parsed.selectedSiteId,
        MAX_INTEGRATION_ACCOUNT_ID_BYTES
      )
    }
    const sites: JiraSite[] = []
    assertIntegrationAccountCount('Jira', parsed.sites.length)
    for (const input of parsed.sites) {
      assertStoredSiteBounds(input)
      const site = normalizeSite(input)
      if (!site) {
        throw unreadableIntegrationAccountFileError('Jira')
      }
      if (hasStoredToken(site.id)) {
        sites.push(site)
      }
    }
    const activeSiteId =
      typeof parsed.activeSiteId === 'string' &&
      sites.some((site) => site.id === parsed.activeSiteId)
        ? parsed.activeSiteId
        : (sites[0]?.id ?? null)
    const selectedSiteId =
      parsed.selectedSiteId === 'all' ||
      (typeof parsed.selectedSiteId === 'string' &&
        sites.some((site) => site.id === parsed.selectedSiteId))
        ? parsed.selectedSiteId
        : activeSiteId
    siteFileReadError = null
    return { version: 1, activeSiteId, selectedSiteId, sites }
  } catch {
    siteFileReadError = unreadableIntegrationAccountFileError('Jira')
    return emptySiteFile()
  }
}

function getSiteFile(): JiraSiteFile {
  if (!siteFileLoaded || !cachedSiteFile) {
    cachedSiteFile = readSiteFileFromDisk()
    siteFileLoaded = true
  }
  return cachedSiteFile
}

function writeSiteFile(file: JiraSiteFile): void {
  if (siteFileReadError) {
    throw siteFileReadError
  }
  assertSiteFileBounds(file)
  ensureOrcaDir()
  const sites = file.sites.filter((site) => hasStoredToken(site.id))
  const activeSiteId =
    file.activeSiteId && sites.some((site) => site.id === file.activeSiteId)
      ? file.activeSiteId
      : (sites[0]?.id ?? null)
  const selectedSiteId =
    file.selectedSiteId === 'all'
      ? 'all'
      : file.selectedSiteId && sites.some((site) => site.id === file.selectedSiteId)
        ? file.selectedSiteId
        : activeSiteId

  const nextFile: JiraSiteFile = {
    version: 1,
    activeSiteId,
    selectedSiteId,
    sites
  }
  const serialized = serializeIntegrationAccountFile(nextFile)
  writeFileSync(getSiteFilePath(), serialized, {
    encoding: 'utf-8',
    mode: 0o600
  })
  cachedSiteFile = nextFile
  siteFileLoaded = true
}

function writeEncryptedToken(path: string, apiToken: string): void {
  assertIntegrationCredentialBytes('Jira', apiToken)
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(apiToken)
    if (encrypted.length > MAX_INTEGRATION_ACCOUNT_FILE_BYTES) {
      throw new IntegrationAccountPersistenceLimitError(
        `Jira encrypted credential exceeds ${MAX_INTEGRATION_ACCOUNT_FILE_BYTES} bytes.`
      )
    }
    writeFileSync(path, encrypted, { mode: 0o600 })
    return
  }
  console.warn('[jira] safeStorage encryption unavailable — storing token in plaintext')
  writeFileSync(path, apiToken, { encoding: 'utf-8', mode: 0o600 })
}

function readToken(siteId: string): string | null {
  const cached = cachedTokens.get(siteId)
  if (cached !== undefined) {
    return cached
  }
  const path = getTokenPath(siteId)
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readIntegrationCredentialFileSync(path)
    const token = readStoredCredentialToken('Jira', raw)
    if (token) {
      assertIntegrationCredentialBytes('Jira', token)
      cacheToken(siteId, token)
    }
    credentialErrors.delete(siteId)
    return token
  } catch (error) {
    if (
      error instanceof CredentialDecryptionError ||
      error instanceof IntegrationAccountPersistenceLimitError
    ) {
      credentialErrors.set(siteId, error.message)
      throw error
    }
    return null
  }
}

function saveToken(siteId: string, apiToken: string): void {
  ensureOrcaDir()
  ensureTokenDir()
  writeEncryptedToken(getTokenPath(siteId), apiToken)
  cacheToken(siteId, apiToken)
  credentialErrors.delete(siteId)
}

function deleteToken(siteId: string): void {
  cachedTokens.delete(siteId)
  credentialErrors.delete(siteId)
  try {
    unlinkSync(getTokenPath(siteId))
  } catch {
    // Token may not exist — safe to ignore.
  }
}

export function normalizeJiraSiteUrl(siteUrl: string): string {
  const trimmed = siteUrl.trim()
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withProtocol)
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function getSiteId(siteUrl: string, email: string): string {
  return createHash('sha256')
    .update(`${siteUrl}\n${email.toLowerCase()}`)
    .digest('base64url')
    .slice(0, 24)
}

function toViewer(data: Record<string, unknown>, fallbackEmail: string): JiraViewer {
  const avatarUrls = data.avatarUrls as Record<string, unknown> | undefined
  // Server/DC /myself has no accountId; its stable identifiers are name/key.
  const accountId =
    typeof data.accountId === 'string'
      ? data.accountId
      : typeof data.name === 'string'
        ? data.name
        : typeof data.key === 'string'
          ? data.key
          : ''
  return {
    accountId,
    displayName: typeof data.displayName === 'string' ? data.displayName : fallbackEmail,
    email: typeof data.emailAddress === 'string' ? data.emailAddress : fallbackEmail,
    avatarUrl:
      typeof avatarUrls?.['48x48'] === 'string'
        ? avatarUrls['48x48']
        : typeof avatarUrls?.['32x32'] === 'string'
          ? avatarUrls['32x32']
          : undefined
  }
}

function siteToViewer(site: JiraSite | null): JiraViewer | null {
  if (!site) {
    return null
  }
  return {
    accountId: site.accountId,
    displayName: site.displayName,
    email: site.email
  }
}

function authHeader(email: string, apiToken: string, authType?: JiraAuthType): string {
  // Self-hosted with no username = a personal access token (Bearer); Basic auth
  // with a PAT in the password slot is what produces the 401s users report.
  // Self-hosted WITH a username is classic username+password Basic auth, which
  // older Server/DC instances (predating PATs) require. Cloud is always Basic.
  if (authType === 'server' && !email) {
    return `Bearer ${apiToken}`
  }
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
}

function describeErrorCause(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('cause' in error)) {
    return undefined
  }
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) {
    return boundedIntegrationErrorMessage(`${cause.name}: ${cause.message}`)
  }
  return cause === undefined ? undefined : boundedIntegrationErrorMessage(cause)
}

async function jiraFetch(url: string, init: RequestInit): Promise<Response> {
  return withSpan(
    'jira.request',
    async (span) => {
      span.setAttribute('jira.siteUrl', new URL(url).origin)
      await ensureElectronProxyFromEnvironment({
        proxySession: session.defaultSession,
        probeUrl: url
      }).catch((error) => {
        span.addEvent('jira.proxySetupFailed', {
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: boundedIntegrationErrorMessage(error)
        })
      })
      try {
        // Why: Electron's network stack follows Chromium proxy/session state,
        // avoiding undici's stale keep-alive sockets after VPN path changes.
        return await net.fetch(url, init)
      } catch (error) {
        span.setAttribute(
          'jira.transportErrorName',
          error instanceof Error ? error.name : typeof error
        )
        span.setAttribute('jira.transportErrorMessage', boundedIntegrationErrorMessage(error))
        const cause = describeErrorCause(error)
        if (cause) {
          span.setAttribute('jira.transportErrorCause', cause)
        }
        throw error
      }
    },
    { kind: 'client' }
  )
}

async function requestWithCredentials(
  siteUrl: string,
  email: string,
  apiToken: string,
  path: string,
  init?: RequestInit,
  authType?: JiraAuthType
): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('User-Agent', JIRA_API_USER_AGENT)
  headers.set('Authorization', authHeader(email, apiToken, authType))
  const response = await jiraFetch(`${siteUrl}${path}`, {
    ...init,
    headers
  })
  if (!response.ok) {
    throw new JiraApiError(await readJiraError(response), response.status)
  }
  if (response.status === 204) {
    return null
  }
  return readFetchResponseJsonWithinLimit<unknown>(response)
}

async function readJiraError(response: Response): Promise<string> {
  try {
    const data = await readFetchResponseJsonWithinLimit<{
      errorMessages?: string[]
      errors?: Record<string, string>
      message?: string
    }>(response)
    const messages = [
      ...(Array.isArray(data.errorMessages) ? data.errorMessages : []),
      ...Object.values(data.errors ?? {}),
      ...(data.message ? [data.message] : [])
    ].filter(Boolean)
    if (messages.length > 0) {
      return messages.join('; ')
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `Jira request failed (${response.status})`
}

export async function jiraRequest<T>(
  client: JiraClientForSite,
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('User-Agent', JIRA_API_USER_AGENT)
  headers.set('Authorization', client.authorization)
  const response = await jiraFetch(`${client.site.siteUrl}${path}`, {
    ...init,
    headers
  })
  if (!response.ok) {
    throw new JiraApiError(await readJiraError(response), response.status)
  }
  if (response.status === 204) {
    return null as T
  }
  return await readFetchResponseJsonWithinLimit<T>(response)
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
      token = readToken(site.id)
    } catch (error) {
      // Why: under an 'all' selection one un-decryptable site must not collapse
      // reads for the healthy ones. readToken already recorded the per-site
      // credentialError for getStatus to surface, so skip this site like a
      // missing token. A specific-site selection still rethrows so the renderer
      // can surface the decrypt banner promptly.
      if (
        isAllSelection &&
        (error instanceof CredentialDecryptionError ||
          error instanceof IntegrationAccountPersistenceLimitError)
      ) {
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
  try {
    assertIntegrationStringBytes(
      'Jira',
      'site URL',
      args.siteUrl,
      MAX_INTEGRATION_ACCOUNT_URL_BYTES
    )
    assertIntegrationStringBytes('Jira', 'email', args.email, MAX_INTEGRATION_ACCOUNT_EMAIL_BYTES)
    assertIntegrationCredentialBytes('Jira', args.apiToken)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? boundedIntegrationErrorMessage(error) : 'Connection failed.'
    }
  }
  let siteUrl: string
  try {
    siteUrl = normalizeJiraSiteUrl(args.siteUrl)
    assertIntegrationStringBytes('Jira', 'site URL', siteUrl, MAX_INTEGRATION_ACCOUNT_URL_BYTES)
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

  getSiteFile()
  if (siteFileReadError) {
    return { ok: false, error: siteFileReadError.message }
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
    const file = getSiteFile()
    const nextFile: JiraSiteFile = {
      version: 1,
      activeSiteId: id,
      selectedSiteId: id,
      sites: [site, ...file.sites.filter((entry) => entry.id !== id)]
    }
    assertSiteFileBounds(nextFile)
    serializeIntegrationAccountFile(nextFile)
    saveToken(id, apiToken)
    writeSiteFile(nextFile)
    return { ok: true, viewer }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? boundedIntegrationErrorMessage(error) : 'Connection failed.'
    }
  } finally {
    release()
  }
}

export function disconnect(siteId?: string): void {
  const file = getSiteFile()
  if (siteFileReadError) {
    throw siteFileReadError
  }
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
    return {
      ok: false,
      error: error instanceof Error ? boundedIntegrationErrorMessage(error) : 'Connection failed.'
    }
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
    return {
      ok: false,
      error: error instanceof Error ? boundedIntegrationErrorMessage(error) : 'Connection failed.'
    }
  } finally {
    release()
  }
}

export function clearToken(siteId: string): void {
  const file = getSiteFile()
  if (siteFileReadError) {
    throw siteFileReadError
  }
  deleteToken(siteId)
  writeSiteFile({ ...file, sites: file.sites.filter((site) => site.id !== siteId) })
}

export function isAuthError(error: unknown): boolean {
  // Why: Jira returns 403 for project/API permission gaps even when /myself
  // succeeds, so only 401 means the saved credential itself is invalid.
  return error instanceof JiraApiError && error.status === 401
}
