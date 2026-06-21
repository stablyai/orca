/* eslint-disable max-lines -- Why: Jira credential storage and authenticated
request plumbing share one boundary so encrypted token lifecycle and
multi-site selection cannot drift between task operations. */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { net, safeStorage, session } from 'electron'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken
} from '../integration-credential-file'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { withSpan } from '../observability/tracer'
import type {
  JiraConnectArgs,
  JiraConnectionStatus,
  JiraSite,
  JiraSiteSelection,
  JiraViewer
} from '../../shared/types'

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

export class JiraApiError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

let cachedSiteFile: JiraSiteFile | null = null
let siteFileLoaded = false
const cachedTokens = new Map<string, string>()
// Why: decrypt failures are recorded per site so getStatus can explain
// failing reads without re-touching the keychain on every status poll.
const credentialErrors = new Map<string, string>()

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
    accountId: record.accountId
  }
}

function readSiteFileFromDisk(): JiraSiteFile {
  const path = getSiteFilePath()
  if (!existsSync(path)) {
    return emptySiteFile()
  }
  try {
    const parsed = JSON.parse(readFileSync(path, { encoding: 'utf-8' })) as Partial<JiraSiteFile>
    const sites = Array.isArray(parsed.sites)
      ? parsed.sites
          .map((site) => normalizeSite(site))
          .filter((site): site is JiraSite => site !== null)
          .filter((site) => hasStoredToken(site.id))
      : []
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
    return { version: 1, activeSiteId, selectedSiteId, sites }
  } catch {
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

  cachedSiteFile = {
    version: 1,
    activeSiteId,
    selectedSiteId,
    sites
  }
  siteFileLoaded = true
  writeFileSync(getSiteFilePath(), JSON.stringify(cachedSiteFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
}

function writeEncryptedToken(path: string, apiToken: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(path, safeStorage.encryptString(apiToken), { mode: 0o600 })
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
    const raw = readFileSync(path)
    const token = readStoredCredentialToken('Jira', raw)
    if (token) {
      cachedTokens.set(siteId, token)
    }
    credentialErrors.delete(siteId)
    return token
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
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
  cachedTokens.set(siteId, apiToken)
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
  return {
    accountId: typeof data.accountId === 'string' ? data.accountId : '',
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

function authHeader(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
}

function describeErrorCause(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('cause' in error)) {
    return undefined
  }
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`
  }
  return cause === undefined ? undefined : String(cause)
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
          errorMessage: error instanceof Error ? error.message : String(error)
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
        span.setAttribute(
          'jira.transportErrorMessage',
          error instanceof Error ? error.message : String(error)
        )
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
  init?: RequestInit
): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', authHeader(email, apiToken))
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
  return response.json()
}

async function readJiraError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as {
      errorMessages?: string[]
      errors?: Record<string, string>
      message?: string
    }
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
  return (await response.json()) as T
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
      if (isAllSelection && error instanceof CredentialDecryptionError) {
        return []
      }
      throw error
    }
    return token ? [{ site, authorization: authHeader(site.email, token) }] : []
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

  const email = args.email.trim()
  const apiToken = args.apiToken.trim()
  if (!email || !apiToken) {
    return { ok: false, error: 'Email and API token are required.' }
  }

  await acquire()
  try {
    const viewer = toViewer(
      (await requestWithCredentials(siteUrl, email, apiToken, '/rest/api/3/myself')) as Record<
        string,
        unknown
      >,
      email
    )
    const id = getSiteId(siteUrl, email)
    const site: JiraSite = {
      id,
      siteUrl,
      email,
      displayName: viewer.displayName,
      accountId: viewer.accountId
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
      (await jiraRequest(client, '/rest/api/3/myself')) as Record<string, unknown>,
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
  const file = getSiteFile()
  writeSiteFile({ ...file, sites: file.sites.filter((site) => site.id !== siteId) })
}

export function isAuthError(error: unknown): boolean {
  // Why: Jira returns 403 for project/API permission gaps even when /myself
  // succeeds, so only 401 means the saved credential itself is invalid.
  return error instanceof JiraApiError && error.status === 401
}
