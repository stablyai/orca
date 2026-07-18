/* eslint-disable max-lines -- Why: cookie import is a single pipeline (detect → decrypt → stage → swap)
   that must stay together so the encryption, schema, and staging steps remain in sync. */
import { app, type BrowserWindow, dialog, session } from 'electron'
import { execFileSync } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Why: writing to userData instead of tmpdir() so the diag log is only
// readable by the current user, not world-readable in /tmp.
let _diagLog: string | null = null
function getDiagLogPath(): string {
  if (!_diagLog) {
    try {
      _diagLog = join(app.getPath('userData'), 'cookie-import-diag.log')
    } catch {
      _diagLog = join(tmpdir(), 'orca-cookie-import-diag.log')
    }
  }
  return _diagLog
}
function reasonWithDiagLog(reason: string): string {
  return `${reason} Details were written to ${getDiagLogPath()}.`
}
const COOKIE_IMPORT_ERROR_SUMMARY_MAX_CHARS = 180
const COOKIE_IMPORT_ERROR_SCAN_MAX_CHARS = 512

// Why: imported cookie errors can include pasted or file-derived payloads;
// diagnostics only need a short preview, not a full-string whitespace pass.
export function summarizeCookieImportError(err: unknown): string {
  const raw = err instanceof Error && err.message ? err.message : String(err)
  let summary = ''
  let previousWasWhitespace = false
  const scanLimit = Math.min(raw.length, COOKIE_IMPORT_ERROR_SCAN_MAX_CHARS)
  for (let index = 0; index < scanLimit; index += 1) {
    const code = raw.charCodeAt(index)
    if (code === 32 || (code >= 9 && code <= 13)) {
      if (summary.length > 0 && !previousWasWhitespace) {
        summary += ' '
      }
      previousWasWhitespace = true
      continue
    }
    summary += raw.charAt(index)
    if (summary.length >= COOKIE_IMPORT_ERROR_SUMMARY_MAX_CHARS) {
      return summary.slice(0, COOKIE_IMPORT_ERROR_SUMMARY_MAX_CHARS)
    }
    previousWasWhitespace = false
  }
  return summary
}
function diag(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    appendFileSync(getDiagLogPath(), line)
  } catch {
    /* best-effort */
  }
  console.log('[cookie-import]', msg)
}
import type {
  BrowserCookieImportScope,
  BrowserCookieImportResult,
  BrowserCookieImportSummary,
  BrowserSessionProfileSource,
  WebAiProvider
} from '../../shared/types'
import {
  browserCookieDomainMatchesScope,
  normalizeBrowserCookieDomain,
  normalizeBrowserCookieImportScope
} from '../../shared/browser-cookie-import-scope'
import { getWebAiProvider, isWebAiProvider } from '../../shared/web-ai-accounts'
import { browserSessionRegistry } from './browser-session-registry'
import { setupClientHintsOverride } from './browser-session-ua'
import {
  createChromiumCookieSnapshot,
  type ChromiumCookieSnapshot
} from './chromium-cookie-snapshot'
import { resolveChromiumCookiesPath } from './chromium-cookie-path'

// ---------------------------------------------------------------------------
// Browser detection
// ---------------------------------------------------------------------------

export type BrowserProfile = {
  name: string
  directory: string
}

export type DetectedBrowser = {
  family: BrowserSessionProfileSource['browserFamily']
  label: string
  cookiesPath: string
  keychainService?: string
  keychainAccount?: string
  profiles: BrowserProfile[]
  selectedProfile: string
}

type ChromiumBrowserDef = {
  family: BrowserSessionProfileSource['browserFamily']
  label: string
  keychainService: string
  keychainAccount: string
  // Why: each platform stores browser data in a different location. The per-platform
  // root paths are resolved at detection time via browserRootPath().
  macRoot?: string
  winRoot?: string
  linuxRoot?: string
}

const CHROMIUM_BROWSERS: ChromiumBrowserDef[] = [
  {
    family: 'chrome',
    label: 'Google Chrome',
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
    macRoot: 'Google/Chrome',
    winRoot: 'Google/Chrome/User Data',
    linuxRoot: 'google-chrome'
  },
  {
    family: 'edge',
    label: 'Microsoft Edge',
    keychainService: 'Microsoft Edge Safe Storage',
    keychainAccount: 'Microsoft Edge',
    macRoot: 'Microsoft Edge',
    winRoot: 'Microsoft/Edge/User Data',
    linuxRoot: 'microsoft-edge'
  },
  {
    family: 'arc',
    label: 'Arc',
    keychainService: 'Arc Safe Storage',
    keychainAccount: 'Arc',
    macRoot: 'Arc/User Data'
  },
  {
    family: 'chromium',
    label: 'Brave',
    keychainService: 'Brave Safe Storage',
    keychainAccount: 'Brave',
    macRoot: 'BraveSoftware/Brave-Browser',
    winRoot: 'BraveSoftware/Brave-Browser/User Data',
    linuxRoot: 'BraveSoftware/Brave-Browser'
  },
  {
    family: 'comet',
    label: 'Comet',
    keychainService: 'Comet Safe Storage',
    keychainAccount: 'Comet',
    macRoot: 'Comet',
    winRoot: 'Comet/User Data'
    // linuxRoot intentionally omitted — Comet does not ship a Linux build as of 2026-05-15
  },
  {
    family: 'helium',
    // Why: Helium deviates from the '<Browser> Safe Storage'/'<Browser>' convention —
    // its Keychain entry is literally service 'Helium Storage Key', account 'Helium'.
    label: 'Helium',
    keychainService: 'Helium Storage Key',
    keychainAccount: 'Helium',
    macRoot: 'net.imput.helium'
    // winRoot/linuxRoot intentionally omitted — only the macOS install is verified
  }
]

function browserRootPath(def: ChromiumBrowserDef): string | null {
  if (process.platform === 'darwin') {
    if (!def.macRoot) {
      return null
    }
    const home = process.env.HOME ?? ''
    return join(home, 'Library', 'Application Support', def.macRoot)
  }
  if (process.platform === 'win32') {
    if (!def.winRoot) {
      return null
    }
    const localAppData = process.env.LOCALAPPDATA ?? ''
    if (!localAppData) {
      return null
    }
    return join(localAppData, def.winRoot)
  }
  // Linux
  if (!def.linuxRoot) {
    return null
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config')
  return join(configHome, def.linuxRoot)
}

function isSafeBrowserProfileDirectory(directory: string): boolean {
  return (
    directory.length > 0 &&
    directory !== '.' &&
    !directory.includes('\0') &&
    !directory.includes('/') &&
    !directory.includes('\\') &&
    !directory.includes('..')
  )
}

// Why: Chrome's Local State JSON contains profile.info_cache which maps profile
// directory names (e.g. "Default", "Profile 1") to metadata including the
// user-visible display name. This lets us show human-readable names in the picker.
function discoverProfiles(browserRoot: string): BrowserProfile[] {
  try {
    const localStatePath = join(browserRoot, 'Local State')
    if (!existsSync(localStatePath)) {
      return [{ name: 'Default', directory: 'Default' }]
    }
    const raw = readFileSync(localStatePath, 'utf-8')
    const localState = JSON.parse(raw)
    const infoCache = localState?.profile?.info_cache
    if (!infoCache || typeof infoCache !== 'object') {
      return [{ name: 'Default', directory: 'Default' }]
    }
    const profiles: BrowserProfile[] = []
    for (const [dir, info] of Object.entries(infoCache)) {
      // Why: Local State is external metadata, but profile dirs become path segments.
      if (!isSafeBrowserProfileDirectory(dir)) {
        continue
      }
      const profileName = (info as { name?: string })?.name ?? dir
      profiles.push({ name: profileName, directory: dir })
    }
    return profiles.length > 0 ? profiles : [{ name: 'Default', directory: 'Default' }]
  } catch {
    return [{ name: 'Default', directory: 'Default' }]
  }
}

// ---------------------------------------------------------------------------
// Firefox detection
// ---------------------------------------------------------------------------

function firefoxProfilesRoot(): string | null {
  if (process.platform === 'darwin') {
    const home = process.env.HOME ?? ''
    return join(home, 'Library', 'Application Support', 'Firefox', 'Profiles')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? ''
    return appData ? join(appData, 'Mozilla', 'Firefox', 'Profiles') : null
  }
  const home = process.env.HOME ?? ''
  return join(home, '.mozilla', 'firefox')
}

function discoverFirefoxProfiles(): BrowserProfile[] {
  const profilesRoot = firefoxProfilesRoot()
  if (!profilesRoot) {
    return []
  }
  try {
    if (!existsSync(profilesRoot)) {
      return []
    }
    const entries = readdirSync(profilesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    // Why: Firefox profile dirs are named <random>.<name> (e.g. "abc123.default-release").
    // Prefer 'default-release' as it's the primary user profile on most installs.
    const sorted = entries.sort((a, b) => {
      if (a.includes('default-release')) {
        return -1
      }
      if (b.includes('default-release')) {
        return 1
      }
      if (a.includes('default')) {
        return -1
      }
      if (b.includes('default')) {
        return 1
      }
      return 0
    })
    return sorted.map((dir) => {
      const label = dir.includes('.') ? dir.split('.').slice(1).join('.') : dir
      return { name: label, directory: dir }
    })
  } catch {
    return []
  }
}

function detectFirefox(): DetectedBrowser | null {
  const profilesRoot = firefoxProfilesRoot()
  if (!profilesRoot) {
    return null
  }
  const profiles = discoverFirefoxProfiles()
  for (const profile of profiles) {
    const cookiesPath = join(profilesRoot, profile.directory, 'cookies.sqlite')
    if (existsSync(cookiesPath)) {
      return {
        family: 'firefox',
        label: 'Firefox',
        cookiesPath,
        profiles,
        selectedProfile: profile.directory
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Safari detection
// ---------------------------------------------------------------------------

const MAC_EPOCH_DELTA = 978_307_200

function detectSafari(): DetectedBrowser | null {
  if (process.platform !== 'darwin') {
    return null
  }
  const home = process.env.HOME ?? ''
  const candidates = [
    join(home, 'Library', 'Cookies', 'Cookies.binarycookies'),
    join(
      home,
      'Library',
      'Containers',
      'com.apple.Safari',
      'Data',
      'Library',
      'Cookies',
      'Cookies.binarycookies'
    )
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return {
        family: 'safari',
        label: 'Safari',
        cookiesPath: candidate,
        profiles: [{ name: 'Default', directory: 'Default' }],
        selectedProfile: 'Default'
      }
    }
  }
  return null
}

export function detectInstalledBrowsers(): DetectedBrowser[] {
  const detected: DetectedBrowser[] = []
  for (const browser of CHROMIUM_BROWSERS) {
    const root = browserRootPath(browser)
    if (!root) {
      continue
    }
    const profiles = discoverProfiles(root)
    // Why: a browser is "detected" if at least one profile has a cookies DB.
    // Use the first profile with a valid cookies path as the default selection.
    for (const profile of profiles) {
      const profileDir = join(root, profile.directory)
      const cookiesPath = resolveChromiumCookiesPath(profileDir)
      if (cookiesPath) {
        detected.push({
          family: browser.family,
          label: browser.label,
          keychainService: browser.keychainService,
          keychainAccount: browser.keychainAccount,
          cookiesPath,
          profiles,
          selectedProfile: profile.directory
        })
        break
      }
    }
  }

  const firefox = detectFirefox()
  if (firefox) {
    detected.push(firefox)
  }

  const safari = detectSafari()
  if (safari) {
    detected.push(safari)
  }

  return detected
}

// Why: when the user selects a different profile from the picker, we need to
// resolve the cookies path for that profile. Returns a new DetectedBrowser
// with the updated cookiesPath and selectedProfile, or null if the profile
// has no cookies DB.
export function selectBrowserProfile(
  browser: DetectedBrowser,
  profileDirectory: string
): DetectedBrowser | null {
  if (!isSafeBrowserProfileDirectory(profileDirectory)) {
    return null
  }
  if (browser.family === 'firefox') {
    const profilesRoot = firefoxProfilesRoot()
    if (!profilesRoot) {
      return null
    }
    const cookiesPath = join(profilesRoot, profileDirectory, 'cookies.sqlite')
    if (!existsSync(cookiesPath)) {
      return null
    }
    return { ...browser, cookiesPath, selectedProfile: profileDirectory }
  }

  const browserDef = CHROMIUM_BROWSERS.find((b) => b.family === browser.family)
  if (!browserDef) {
    return null
  }
  const root = browserRootPath(browserDef)
  if (!root) {
    return null
  }
  const profileDir = join(root, profileDirectory)
  const cookiesPath = resolveChromiumCookiesPath(profileDir)
  if (!cookiesPath) {
    return null
  }
  return {
    ...browser,
    cookiesPath,
    selectedProfile: profileDirectory
  }
}

// ---------------------------------------------------------------------------
// Cookie validation (shared between file import and direct import)
// ---------------------------------------------------------------------------

type RawCookieEntry = {
  domain?: unknown
  name?: unknown
  value?: unknown
  path?: unknown
  hostOnly?: unknown
  secure?: unknown
  httpOnly?: unknown
  sameSite?: unknown
  expirationDate?: unknown
}

type ValidatedCookie = {
  url: string
  name: string
  value: string
  domain: string
  path: string
  hostOnly: boolean
  secure: boolean
  httpOnly: boolean
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  expirationDate: number | undefined
}

// Why: Chromium's SQLite schema uses CookieSameSiteForStorage enum:
// 0=UNSPECIFIED, 1=NO_RESTRICTION(None), 2=LAX, 3=STRICT.
// This differs from Firefox (0=None, 1=Lax, 2=Strict).
function chromiumSameSite(raw: number): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
  switch (raw) {
    case 1:
      return 'no_restriction'
    case 2:
      return 'lax'
    case 3:
      return 'strict'
    default:
      return 'unspecified'
  }
}

function firefoxSameSite(raw: number): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
  switch (raw) {
    case 0:
      return 'no_restriction'
    case 1:
      return 'lax'
    case 2:
      return 'strict'
    default:
      return 'unspecified'
  }
}

function normalizeSameSite(raw: unknown): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
  if (typeof raw === 'number') {
    return chromiumSameSite(raw)
  }
  if (typeof raw !== 'string') {
    return 'unspecified'
  }
  const lower = raw.toLowerCase()
  if (lower === 'lax') {
    return 'lax'
  }
  if (lower === 'strict') {
    return 'strict'
  }
  if (lower === 'none' || lower === 'no_restriction') {
    return 'no_restriction'
  }
  return 'unspecified'
}

// Why: Electron's cookies.set() requires a url field to determine the cookie's
// scope. Derive it from the domain + secure flag so the caller doesn't need
// to supply it.
function deriveUrl(domain: string, secure: boolean): string | null {
  const cleanDomain = domain.startsWith('.') ? domain.slice(1) : domain
  if (!cleanDomain || cleanDomain.includes(' ')) {
    return null
  }
  const protocol = secure ? 'https' : 'http'
  try {
    const url = new URL(`${protocol}://${cleanDomain}/`)
    return url.toString()
  } catch {
    return null
  }
}

function normalizeCookieDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.$/, '')
}

type ResolvedCookieImportScope = Pick<BrowserCookieImportScope, 'label' | 'domains'>

type CookieImportScopeResolution =
  | { ok: true; scope: ResolvedCookieImportScope | null }
  | { ok: false; reason: string }

function resolveCookieImportScope(
  webAiProvider?: unknown,
  cookieImportScope?: unknown
): CookieImportScopeResolution {
  if (webAiProvider !== undefined && cookieImportScope !== undefined) {
    return {
      ok: false,
      reason: 'Choose either a Web AI provider or a custom cookie import scope.'
    }
  }
  if (webAiProvider !== undefined) {
    if (!isWebAiProvider(webAiProvider)) {
      return { ok: false, reason: 'Invalid Web AI provider.' }
    }
    const provider = getWebAiProvider(webAiProvider)
    if (webAiProvider === 'custom' || provider.cookieDomains.length === 0) {
      return {
        ok: false,
        reason: 'Custom Web AI cookie imports require a validated cookie import scope.'
      }
    }
    const domains = provider.cookieDomains.map((domain) => normalizeBrowserCookieDomain(domain))
    if (domains.some((domain) => !domain)) {
      return { ok: false, reason: 'Invalid Web AI provider cookie scope.' }
    }
    return {
      ok: true,
      scope: { label: provider.label, domains: domains as string[] }
    }
  }
  if (cookieImportScope !== undefined) {
    const normalized = normalizeBrowserCookieImportScope(cookieImportScope)
    if (!normalized) {
      return { ok: false, reason: 'Invalid cookie import scope.' }
    }
    return { ok: true, scope: normalized }
  }
  return { ok: true, scope: null }
}

export function validateBrowserCookieImportScopeRequest(
  webAiProvider?: unknown,
  cookieImportScope?: unknown
): string | null {
  const resolution = resolveCookieImportScope(webAiProvider, cookieImportScope)
  return resolution.ok ? null : resolution.reason
}

export function cookieDomainMatchesWebAiProvider(domain: string, provider: WebAiProvider): boolean {
  return browserCookieDomainMatchesScope(domain, {
    domains: getWebAiProvider(provider).cookieDomains
  })
}

const GOOGLE_INTEGRITY_COOKIE_NAMES = new Set([
  'SIDCC',
  '__Secure-1PSIDCC',
  '__Secure-3PSIDCC',
  '__Secure-STRP',
  'AEC'
])

function isGoogleIntegrityCookie(name: string, domain: string): boolean {
  if (!GOOGLE_INTEGRITY_COOKIE_NAMES.has(name)) {
    return false
  }
  const normalizedDomain = normalizeCookieDomain(domain)
  return normalizedDomain === 'google.com' || normalizedDomain.endsWith('.google.com')
}

function cookieMatchesImportScope(
  domain: string,
  cookieImportScope?: ResolvedCookieImportScope | null
): boolean {
  return cookieImportScope ? browserCookieDomainMatchesScope(domain, cookieImportScope) : true
}

function noMatchingCookiesReason(
  cookieImportScope: ResolvedCookieImportScope,
  sourceLabel: string
): string {
  return `No ${cookieImportScope.label} cookies found in ${sourceLabel}.`
}

function cookieUrlWithPath(domain: string, secure: boolean, path: string): string | null {
  const baseUrl = deriveUrl(domain, secure)
  if (!baseUrl) {
    return null
  }
  const url = new URL(baseUrl)
  url.pathname = path.startsWith('/') ? path : '/'
  return url.toString()
}

async function removeTargetCookiesMatchingScope(
  targetSession: Electron.Session,
  cookieImportScope: ResolvedCookieImportScope
): Promise<{ removed: number; failed: number }> {
  let cookies: Electron.Cookie[]
  try {
    cookies = await targetSession.cookies.get({})
  } catch {
    return { removed: 0, failed: 1 }
  }
  let removed = 0
  let failed = 0
  for (const cookie of cookies) {
    const domain = cookie.domain
    if (
      !domain ||
      !cookieMatchesImportScope(domain, cookieImportScope) ||
      isGoogleIntegrityCookie(cookie.name, domain)
    ) {
      continue
    }
    const url = cookieUrlWithPath(domain, cookie.secure === true, cookie.path ?? '/')
    if (!url) {
      failed++
      continue
    }
    try {
      await targetSession.cookies.remove(url, cookie.name)
      removed++
    } catch {
      failed++
    }
  }
  return { removed, failed }
}

function deleteStagedCookiesMatchingScope(
  database: InstanceType<typeof DatabaseSync>,
  cookieImportScope: ResolvedCookieImportScope
): number {
  const rows = database.prepare('SELECT rowid, host_key, name FROM cookies').all() as {
    rowid: number | bigint
    host_key: string
    name: string
  }[]
  const deleteRow = database.prepare('DELETE FROM cookies WHERE rowid = ?')
  let deleted = 0
  for (const row of rows) {
    if (
      !cookieMatchesImportScope(row.host_key, cookieImportScope) ||
      isGoogleIntegrityCookie(row.name, row.host_key)
    ) {
      continue
    }
    deleteRow.run(row.rowid)
    deleted++
  }
  return deleted
}

type SessionCookieCandidate = {
  domain: string
  name: string
  value: string
  path: string
  hostOnly: boolean
  secure: boolean
  httpOnly: boolean
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  expirationDate: number | undefined
}

function sessionCookieIdentity(
  cookie: Pick<SessionCookieCandidate, 'domain' | 'name' | 'path'>
): string {
  return `${cookie.domain.trim().toLowerCase().replace(/\.$/, '')}\0${cookie.name}\0${cookie.path}`
}

async function setSessionCookie(
  targetSession: Electron.Session,
  cookie: SessionCookieCandidate
): Promise<boolean> {
  const url = deriveUrl(cookie.domain, cookie.secure)
  if (!url) {
    return false
  }
  try {
    const isHostPrefixed = cookie.name.startsWith('__Host-')
    await targetSession.cookies.set({
      url,
      name: cookie.name,
      value: cookie.value,
      ...(cookie.hostOnly || isHostPrefixed ? {} : { domain: cookie.domain }),
      path: isHostPrefixed ? '/' : cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: cookie.expirationDate
    })
    return true
  } catch {
    return false
  }
}

function snapshotCookie(cookie: Electron.Cookie): SessionCookieCandidate | null {
  if (!cookie.domain) {
    return null
  }
  return {
    domain: cookie.domain,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path ?? '/',
    hostOnly: cookie.hostOnly ?? !cookie.domain.startsWith('.'),
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    sameSite: cookie.sameSite ?? 'unspecified',
    expirationDate: cookie.expirationDate
  }
}

async function restoreScopedSessionCookies(
  targetSession: Electron.Session,
  cookieImportScope: ResolvedCookieImportScope,
  snapshot: SessionCookieCandidate[]
): Promise<boolean> {
  const removal = await removeTargetCookiesMatchingScope(targetSession, cookieImportScope)
  let restored = removal.failed === 0
  for (const cookie of snapshot) {
    if (!(await setSessionCookie(targetSession, cookie))) {
      restored = false
    }
  }
  return restored
}

async function replaceScopedSessionCookies(
  targetSession: Electron.Session,
  cookieImportScope: ResolvedCookieImportScope,
  cookies: SessionCookieCandidate[],
  protectedCookieIds = new Set<string>()
): Promise<{ ok: true; imported: number } | { ok: false; reason: string }> {
  let currentCookies: Electron.Cookie[]
  try {
    currentCookies = await targetSession.cookies.get({})
  } catch {
    return {
      ok: false,
      reason: `Could not inspect existing ${cookieImportScope.label} cookies.`
    }
  }
  const snapshot = currentCookies.flatMap((cookie) => {
    if (
      !cookie.domain ||
      !cookieMatchesImportScope(cookie.domain, cookieImportScope) ||
      isGoogleIntegrityCookie(cookie.name, cookie.domain)
    ) {
      return []
    }
    const saved = snapshotCookie(cookie)
    return saved ? [saved] : []
  })
  const successful: SessionCookieCandidate[] = []
  for (const cookie of cookies) {
    if (await setSessionCookie(targetSession, cookie)) {
      successful.push(cookie)
      continue
    }
    if (successful.length > 0) {
      await restoreScopedSessionCookies(targetSession, cookieImportScope, snapshot)
    }
    return {
      ok: false,
      reason: `Could not safely replace existing ${cookieImportScope.label} cookies.`
    }
  }

  const replacementIds = new Set(cookies.map(sessionCookieIdentity))
  const staleCookies = snapshot.filter((cookie) => {
    const identity = sessionCookieIdentity(cookie)
    return !replacementIds.has(identity) && !protectedCookieIds.has(identity)
  })
  for (const cookie of staleCookies) {
    const url = cookieUrlWithPath(cookie.domain, cookie.secure, cookie.path)
    if (!url) {
      await restoreScopedSessionCookies(targetSession, cookieImportScope, snapshot)
      return {
        ok: false,
        reason: `Could not safely replace existing ${cookieImportScope.label} cookies.`
      }
    }
    try {
      await targetSession.cookies.remove(url, cookie.name)
    } catch {
      await restoreScopedSessionCookies(targetSession, cookieImportScope, snapshot)
      return {
        ok: false,
        reason: `Could not safely replace existing ${cookieImportScope.label} cookies.`
      }
    }
  }
  return { ok: true, imported: cookies.length }
}

function validateCookieEntry(raw: RawCookieEntry): ValidatedCookie | null {
  if (typeof raw.domain !== 'string' || raw.domain.trim().length === 0) {
    return null
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    return null
  }
  if (typeof raw.value !== 'string') {
    return null
  }

  const domain = raw.domain.trim()
  const secure = raw.secure === true || raw.secure === 1
  const url = deriveUrl(domain, secure)
  if (!url) {
    return null
  }

  const expirationDate =
    typeof raw.expirationDate === 'number' && raw.expirationDate > 0
      ? raw.expirationDate
      : undefined

  return {
    url,
    name: raw.name.trim(),
    value: raw.value,
    domain,
    path: typeof raw.path === 'string' ? raw.path : '/',
    hostOnly: typeof raw.hostOnly === 'boolean' ? raw.hostOnly : !domain.startsWith('.'),
    secure,
    httpOnly: raw.httpOnly === true || raw.httpOnly === 1,
    sameSite: normalizeSameSite(raw.sameSite),
    expirationDate
  }
}

async function importValidatedCookies(
  cookies: ValidatedCookie[],
  totalInput: number,
  targetPartition: string,
  cookieImportScope?: ResolvedCookieImportScope | null,
  sourceLabel = 'the selected source'
): Promise<BrowserCookieImportResult> {
  const now = Date.now() / 1000
  const relevantCookies = cookies.filter(
    (cookie) =>
      cookieMatchesImportScope(cookie.domain, cookieImportScope) &&
      !isGoogleIntegrityCookie(cookie.name, cookie.domain)
  )
  const expiredCookies = relevantCookies.filter(
    (cookie) => cookie.expirationDate !== undefined && cookie.expirationDate <= now
  )
  const scopedCookies = relevantCookies.filter(
    (cookie) => cookie.expirationDate === undefined || cookie.expirationDate > now
  )
  diag(
    `importValidatedCookies: ${scopedCookies.length} scoped of ${cookies.length} validated / ${totalInput} total, partition="${targetPartition}"`
  )
  if (scopedCookies.length === 0) {
    return {
      ok: false,
      reason: cookieImportScope
        ? noMatchingCookiesReason(cookieImportScope, sourceLabel)
        : 'No importable cookies found.'
    }
  }
  const targetSession = session.fromPartition(targetPartition)
  let importedCount = 0
  let skipped = totalInput - scopedCookies.length
  const domainSet = new Set<string>()

  // Why: Electron's cookies.set() rejects any non-printable-ASCII byte.
  // Strip from all string fields as a safety net.
  const stripNonPrintable = (s: string): string => s.replace(/[^\x20-\x7E]/g, '')

  if (cookieImportScope) {
    const replacement = await replaceScopedSessionCookies(
      targetSession,
      cookieImportScope,
      scopedCookies.map((cookie) => ({
        ...cookie,
        value: stripNonPrintable(cookie.value)
      })),
      new Set(expiredCookies.map(sessionCookieIdentity))
    )
    if (!replacement.ok) {
      return replacement
    }
    importedCount = replacement.imported
    for (const cookie of scopedCookies) {
      const cleanDomain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
      domainSet.add(cleanDomain)
    }
  } else {
    for (const cookie of scopedCookies) {
      try {
        const isHostPrefixed = cookie.name.startsWith('__Host-')
        await targetSession.cookies.set({
          url: cookie.url,
          name: cookie.name,
          value: stripNonPrintable(cookie.value),
          ...(cookie.hostOnly || isHostPrefixed ? {} : { domain: cookie.domain }),
          path: isHostPrefixed ? '/' : cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          expirationDate: cookie.expirationDate
        })
        importedCount++
        // Why: surface only the domain — never name, value, or path — so the
        // renderer can show a useful summary without leaking secret cookie data.
        const cleanDomain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
        domainSet.add(cleanDomain)
      } catch (err) {
        skipped++
        if (skipped <= 5) {
          const val = cookie.value
          let badInfo = 'none found'
          for (let i = 0; i < val.length; i++) {
            const code = val.charCodeAt(i)
            if (code < 0x20 || code > 0x7e) {
              badInfo = `pos=${i} char=U+${code.toString(16).padStart(4, '0')}`
              break
            }
          }
          diag(
            `  cookie.set FAILED: domain=${cookie.domain} name=${cookie.name} valLen=${val.length} badChar=${badInfo} err=${err}`
          )
        }
      }
    }
  }

  if (importedCount === 0) {
    return { ok: false, reason: 'No cookies could be imported.' }
  }

  diag(
    `importValidatedCookies result: imported=${importedCount} skipped=${skipped} domains=${domainSet.size}`
  )

  const summary: BrowserCookieImportSummary = {
    totalCookies: totalInput,
    importedCookies: importedCount,
    skippedCookies: skipped,
    domains: [...domainSet].sort()
  }

  return { ok: true, profileId: '', summary }
}

// ---------------------------------------------------------------------------
// Import from JSON file
// ---------------------------------------------------------------------------

// Why: source selection must be main-owned via a native open dialog so a
// compromised renderer cannot turn cookie import into arbitrary file reads.
export async function pickCookieFile(parentWindow: BrowserWindow | null): Promise<string | null> {
  const opts = {
    title: 'Import Cookies',
    filters: [
      { name: 'Cookie Files', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile' as const]
  }
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, opts)
    : await dialog.showOpenDialog(opts)

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
}

export async function importCookiesFromFile(
  filePath: string,
  targetPartition: string,
  webAiProvider?: WebAiProvider,
  cookieImportScope?: BrowserCookieImportScope
): Promise<BrowserCookieImportResult> {
  const scopeResolution = resolveCookieImportScope(webAiProvider, cookieImportScope)
  if (!scopeResolution.ok) {
    return scopeResolution
  }
  let rawContent: string
  try {
    rawContent = await readFile(filePath, 'utf-8')
  } catch {
    return { ok: false, reason: 'Could not read the selected file.' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    return { ok: false, reason: 'File is not valid JSON.' }
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'Expected a JSON array of cookie objects.' }
  }

  if (parsed.length === 0) {
    return { ok: false, reason: 'Cookie file is empty.' }
  }

  const validated: ValidatedCookie[] = []
  let skipped = 0
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      skipped++
      continue
    }
    const cookie = validateCookieEntry(entry as RawCookieEntry)
    if (cookie) {
      validated.push(cookie)
    } else {
      skipped++
    }
  }

  if (validated.length === 0) {
    return {
      ok: false,
      reason: `No valid cookies found. ${skipped} entries were skipped due to missing or invalid fields.`
    }
  }

  return importValidatedCookies(
    validated,
    parsed.length,
    targetPartition,
    scopeResolution.scope,
    'the selected file'
  )
}

// ---------------------------------------------------------------------------
// Direct import from installed Chromium browser
// ---------------------------------------------------------------------------

// Why: Google and other services bind auth cookies to the User-Agent that
// created them. We read the source browser's real version from its plist
// and construct a matching UA string so imported sessions aren't invalidated.
export function getUserAgentForBrowser(
  family: BrowserSessionProfileSource['browserFamily']
): string | null {
  // Why: UA spoofing uses macOS-specific plist reading. On other platforms,
  // skip UA override — the default Electron UA is acceptable.
  if (process.platform !== 'darwin') {
    return null
  }

  const platform = 'Macintosh; Intel Mac OS X 10_15_7'
  const chromeBase = 'AppleWebKit/537.36 (KHTML, like Gecko)'

  function readBrowserVersion(
    appPath: string,
    plistKey = 'CFBundleShortVersionString'
  ): string | null {
    try {
      return (
        execFileSync('defaults', ['read', `${appPath}/Contents/Info`, plistKey], {
          encoding: 'utf-8',
          timeout: 5_000
        }).trim() || null
      )
    } catch {
      return null
    }
  }

  switch (family) {
    case 'chrome': {
      const v = readBrowserVersion('/Applications/Google Chrome.app')
      return v ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36` : null
    }
    case 'edge': {
      const v = readBrowserVersion('/Applications/Microsoft Edge.app')
      return v ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36 Edg/${v}` : null
    }
    case 'arc': {
      const v = readBrowserVersion('/Applications/Arc.app')
      return v ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36` : null
    }
    case 'chromium': {
      const v = readBrowserVersion('/Applications/Brave Browser.app')
      return v ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36` : null
    }
    case 'comet': {
      // Why: Comet is Chromium-based and ships a Chrome-shaped version in its plist.
      // Use the same UA shape as Chrome itself so Google-bound auth cookies survive import.
      const v = readBrowserVersion('/Applications/Comet.app')
      return v ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36` : null
    }
    case 'helium': {
      // Why: Helium is Chromium-based and ships a Chrome-shaped version in its plist.
      // Use the same UA shape as Chrome itself so Google-bound auth cookies survive import.
      const v = readBrowserVersion('/Applications/Helium.app')
      return v ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36` : null
    }
    case 'firefox':
    case 'safari':
    case 'manual':
      return null
  }
}

const PBKDF2_ITERATIONS = 1003
const PBKDF2_KEY_LENGTH = 16
const PBKDF2_SALT = 'saltysalt'

const CHROMIUM_EPOCH_OFFSET = 11644473600n

function chromiumTimestampToUnix(chromiumTs: bigint | number | string): number {
  if (!chromiumTs || chromiumTs === 0n || chromiumTs === 0 || chromiumTs === '0') {
    return 0
  }
  try {
    const ts =
      typeof chromiumTs === 'bigint'
        ? chromiumTs
        : BigInt(typeof chromiumTs === 'number' ? Math.round(chromiumTs) : chromiumTs)
    if (ts === 0n) {
      return 0
    }
    return Math.max(Number(ts / 1000000n - CHROMIUM_EPOCH_OFFSET), 0)
  } catch {
    return 0
  }
}

// Why: each platform uses a different mechanism to protect the Chromium cookie encryption key.
// macOS: PBKDF2(keychain password, "saltysalt", 1003 iterations) → AES-128-CBC
// Linux: PBKDF2(keyring password or "peanuts", "saltysalt", 1 iteration) → AES-128-CBC
// Windows: DPAPI-encrypted master key from Local State → AES-256-GCM

type EncryptionKeyResult = {
  key: Buffer
  mode: 'aes-128-cbc' | 'aes-256-gcm'
  // Why: Linux v10 cookies use a hardcoded "peanuts" password while v11 uses the
  // keyring password. We need both keys to decrypt the full cookie set.
  fallbackKey?: Buffer
}

export type ChromiumCookieColumnInfo = {
  name: string
  type?: string
  notnull?: number | bigint
  dflt_value?: unknown
}

function parseSqliteDefaultValue(raw: unknown, type: string): string | number | Buffer | null {
  if (raw === null || raw === undefined) {
    return null
  }
  if (typeof raw !== 'string') {
    return typeof raw === 'number' || typeof raw === 'bigint' ? Number(raw) : String(raw)
  }

  const trimmed = raw.trim()
  if (!trimmed || trimmed.toUpperCase() === 'NULL') {
    return null
  }
  if (/^X''$/i.test(trimmed) || type.includes('BLOB')) {
    return Buffer.alloc(0)
  }
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).replaceAll("''", "'")
  }
  if (type.includes('INT')) {
    const numeric = Number(trimmed)
    return Number.isFinite(numeric) ? numeric : 0
  }
  return trimmed
}

function normalizeSqliteCookieValue(value: unknown): string | number | bigint | Buffer | null {
  if (value instanceof Uint8Array) {
    return Buffer.from(value)
  }
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') {
    return value
  }
  return String(value)
}

function isSqliteNotNull(column: ChromiumCookieColumnInfo): boolean {
  return Number(column.notnull ?? 0) !== 0
}

function fallbackChromiumCookieColumnValue(
  column: ChromiumCookieColumnInfo,
  sourceRow: Record<string, unknown>
): string | number | bigint | Buffer | null {
  const type = (column.type ?? '').toUpperCase()
  const defaultValue = parseSqliteDefaultValue(column.dflt_value, type)
  if (defaultValue !== null) {
    return defaultValue
  }
  if (!isSqliteNotNull(column)) {
    return null
  }

  switch (column.name) {
    case 'value':
    case 'encrypted_value':
      return Buffer.alloc(0)
    case 'top_frame_site_key':
      return ''
    case 'source_port':
      return -1
    case 'last_update_utc':
      return normalizeSqliteCookieValue(sourceRow.creation_utc) ?? 0
    default:
      if (type.includes('BLOB')) {
        return Buffer.alloc(0)
      }
      if (type.includes('INT')) {
        return 0
      }
      return ''
  }
}

export function buildChromiumCookieInsertParams(
  targetColumns: ChromiumCookieColumnInfo[],
  sourceRow: Record<string, unknown>,
  decryptedValue: Buffer
): (string | number | bigint | Buffer | null)[] {
  return targetColumns.map((column) => {
    if (column.name === 'encrypted_value') {
      return Buffer.alloc(0)
    }
    if (column.name === 'value') {
      return decryptedValue
    }

    const sourceHasColumn = Object.prototype.hasOwnProperty.call(sourceRow, column.name)
    const sourceValue = sourceHasColumn ? normalizeSqliteCookieValue(sourceRow[column.name]) : null
    if (sourceValue !== null) {
      return sourceValue
    }
    if (sourceHasColumn && !isSqliteNotNull(column)) {
      return null
    }

    // Why: Chromium cookie DB columns drift across Chrome/Electron versions.
    // Missing NOT NULL target columns must get safe Chromium defaults, not NULL.
    return fallbackChromiumCookieColumnValue(column, sourceRow)
  })
}

function getEncryptionKey(
  keychainService: string,
  keychainAccount: string,
  browser?: DetectedBrowser
): EncryptionKeyResult | null {
  if (process.platform === 'darwin') {
    return getMacEncryptionKey(keychainService, keychainAccount)
  }
  if (process.platform === 'linux') {
    return getLinuxEncryptionKey(keychainService, keychainAccount)
  }
  if (process.platform === 'win32' && browser) {
    return getWindowsEncryptionKey(browser)
  }
  return null
}

function getMacEncryptionKey(
  keychainService: string,
  keychainAccount: string
): EncryptionKeyResult | null {
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', keychainService, '-a', keychainAccount, '-w'],
      { encoding: 'utf-8', timeout: 30_000 }
    ).trim()
    return {
      key: pbkdf2Sync(raw, PBKDF2_SALT, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha1'),
      mode: 'aes-128-cbc'
    }
  } catch {
    return null
  }
}

function getLinuxEncryptionKey(
  keychainService: string,
  keychainAccount: string
): EncryptionKeyResult | null {
  // Why: Linux v10 cookies use the hardcoded password "peanuts" with 1 PBKDF2
  // iteration. v11 cookies use the actual keyring password. We derive both keys
  // so the decrypt function can try each based on the version prefix.
  const v10Key = pbkdf2Sync('peanuts', PBKDF2_SALT, 1, PBKDF2_KEY_LENGTH, 'sha1')

  let keyringPassword = ''
  try {
    // Why: GNOME keyring stores the Chrome Safe Storage password via secret-tool.
    keyringPassword = execFileSync(
      'secret-tool',
      ['lookup', 'service', keychainService, 'account', keychainAccount],
      { encoding: 'utf-8', timeout: 5_000 }
    ).trim()
  } catch {
    // Why: fall back to application-based lookup used by newer Chromium versions.
    try {
      const app = keychainAccount.toLowerCase().replaceAll(' ', '')
      keyringPassword = execFileSync('secret-tool', ['lookup', 'application', app], {
        encoding: 'utf-8',
        timeout: 5_000
      }).trim()
    } catch {
      diag('  Linux keyring unavailable — v11 cookies may fail to decrypt')
    }
  }

  const v11Key = pbkdf2Sync(keyringPassword, PBKDF2_SALT, 1, PBKDF2_KEY_LENGTH, 'sha1')
  return { key: v11Key, mode: 'aes-128-cbc', fallbackKey: v10Key }
}

function getWindowsEncryptionKey(browser: DetectedBrowser): EncryptionKeyResult | null {
  const browserDef = CHROMIUM_BROWSERS.find((b) => b.family === browser.family)
  if (!browserDef) {
    return null
  }
  const root = browserRootPath(browserDef)
  if (!root) {
    return null
  }

  const localStatePath = join(root, 'Local State')
  if (!existsSync(localStatePath)) {
    return null
  }

  try {
    const raw = readFileSync(localStatePath, 'utf-8')
    const localState = JSON.parse(raw)
    const encryptedKeyB64 = localState?.os_crypt?.encrypted_key
    if (typeof encryptedKeyB64 !== 'string') {
      return null
    }

    const encryptedKey = Buffer.from(encryptedKeyB64, 'base64')
    const dpapiPrefix = Buffer.from('DPAPI', 'utf-8')
    if (!encryptedKey.subarray(0, dpapiPrefix.length).equals(dpapiPrefix)) {
      return null
    }

    // Why: PowerShell DPAPI decrypt is the only way to access the master key
    // without native addons. The key is passed via stdin to prevent injection.
    const dpapiData = encryptedKey.subarray(dpapiPrefix.length).toString('base64')
    const script = [
      'try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop }',
      'catch { try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch {} };',
      '$in=[Convert]::FromBase64String([Console]::In.ReadLine());',
      '$out=[System.Security.Cryptography.ProtectedData]::Unprotect($in,$null,',
      '[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '[Convert]::ToBase64String($out)'
    ].join('')

    const result = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf-8', timeout: 10_000, input: dpapiData }
    ).trim()

    return { key: Buffer.from(result, 'base64'), mode: 'aes-256-gcm' }
  } catch (err) {
    diag(`  Windows DPAPI key extraction failed: ${err}`)
    return null
  }
}

// Why: Chromium 127+ prepends a 32-byte per-host HMAC to the cookie value
// before encrypting. After AES-CBC decryption, the raw output is:
//   [32-byte HMAC] [actual cookie value]
// Detection: the HMAC is a hash, so roughly half its bytes are non-printable
// ASCII. Real cookie values are overwhelmingly printable. If ≥8 of the first
// 32 bytes are non-printable, it's an HMAC prefix.
const CHROMIUM_COOKIE_HMAC_LEN = 32

function hasHmacPrefix(buf: Buffer): boolean {
  if (buf.length <= CHROMIUM_COOKIE_HMAC_LEN) {
    return false
  }
  let nonPrintable = 0
  for (let i = 0; i < CHROMIUM_COOKIE_HMAC_LEN; i++) {
    if (buf[i] < 0x20 || buf[i] > 0x7e) {
      nonPrintable++
    }
  }
  return nonPrintable >= 8
}

function stripHmac(buf: Buffer): Buffer {
  return hasHmacPrefix(buf) ? buf.subarray(CHROMIUM_COOKIE_HMAC_LEN) : buf
}

function decryptCookieValueRaw(
  encryptedBuffer: Buffer,
  keyResult: EncryptionKeyResult
): Buffer | null {
  if (!encryptedBuffer || encryptedBuffer.length === 0) {
    return null
  }
  const version = encryptedBuffer.subarray(0, 3).toString('utf-8')
  if (!/^v\d\d$/.test(version)) {
    return null
  }

  if (keyResult.mode === 'aes-256-gcm') {
    return decryptAes256Gcm(encryptedBuffer.subarray(3), keyResult.key)
  }

  // AES-128-CBC (macOS and Linux)
  const ciphertext = encryptedBuffer.subarray(3)
  if (!ciphertext.length) {
    return Buffer.alloc(0)
  }

  // Why: Linux v10 uses "peanuts" key, v11 uses keyring key. Try the primary
  // key first, then fallback. macOS uses the same key for both versions.
  const keysToTry =
    version === 'v10' && keyResult.fallbackKey
      ? [keyResult.fallbackKey, keyResult.key]
      : [keyResult.key, ...(keyResult.fallbackKey ? [keyResult.fallbackKey] : [])]

  for (const key of keysToTry) {
    try {
      const iv = Buffer.alloc(16, ' ')
      const decipher = createDecipheriv('aes-128-cbc', key, iv)
      decipher.setAutoPadding(true)
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      return stripHmac(decrypted)
    } catch {
      continue
    }
  }
  return null
}

function decryptAes256Gcm(payload: Buffer, key: Buffer): Buffer | null {
  // Why: Windows AES-256-GCM layout is: [12-byte nonce][ciphertext][16-byte auth tag]
  if (payload.length < 12 + 16) {
    return null
  }
  const nonce = payload.subarray(0, 12)
  const authTag = payload.subarray(-16)
  const ciphertext = payload.subarray(12, -16)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(authTag)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return stripHmac(decrypted)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Safari binary cookie parser
// ---------------------------------------------------------------------------

function decodeSafariBinaryCookies(buffer: Buffer): ValidatedCookie[] {
  if (buffer.length < 8) {
    return []
  }
  if (buffer.subarray(0, 4).toString('utf8') !== 'cook') {
    return []
  }

  const pageCount = buffer.readUInt32BE(4)
  let cursor = 8
  if (cursor + pageCount * 4 > buffer.length) {
    return []
  }
  const pageSizes: number[] = []
  for (let i = 0; i < pageCount; i++) {
    pageSizes.push(buffer.readUInt32BE(cursor))
    cursor += 4
  }

  const cookies: ValidatedCookie[] = []
  for (const pageSize of pageSizes) {
    const page = buffer.subarray(cursor, cursor + pageSize)
    cursor += pageSize
    appendSafariCookies(cookies, decodeSafariPage(page))
  }
  return cookies
}

function appendSafariCookies(target: ValidatedCookie[], cookies: readonly ValidatedCookie[]): void {
  // Why: Safari binary cookie pages can contain generated-size cookie lists;
  // spreading a decoded page into push can exceed JavaScript's argument limit.
  for (const cookie of cookies) {
    target.push(cookie)
  }
}

function decodeSafariPage(page: Buffer): ValidatedCookie[] {
  if (page.length < 16) {
    return []
  }
  if (page.readUInt32BE(0) !== 0x00000100) {
    return []
  }

  const cookieCount = page.readUInt32LE(4)
  if (8 + cookieCount * 4 > page.length) {
    return []
  }
  const offsets: number[] = []
  let cursor = 8
  for (let i = 0; i < cookieCount; i++) {
    offsets.push(page.readUInt32LE(cursor))
    cursor += 4
  }

  const cookies: ValidatedCookie[] = []
  for (const offset of offsets) {
    const cookie = decodeSafariCookie(page.subarray(offset))
    if (cookie) {
      cookies.push(cookie)
    }
  }
  return cookies
}

function decodeSafariCookie(buf: Buffer): ValidatedCookie | null {
  if (buf.length < 48) {
    return null
  }
  // Why: size is read from the binary file and could be attacker-controlled.
  // Clamp to buf.length so readCString cannot escape the cookie's subarray.
  const size = Math.min(buf.readUInt32LE(0), buf.length)
  if (size < 48) {
    return null
  }

  const flags = buf.readUInt32LE(8)
  const secure = (flags & 1) !== 0
  const httpOnly = (flags & 4) !== 0

  const urlOffset = buf.readUInt32LE(16)
  const nameOffset = buf.readUInt32LE(20)
  const pathOffset = buf.readUInt32LE(24)
  const valueOffset = buf.readUInt32LE(28)

  // Why: Safari stores dates as Mac absolute time (seconds since 2001-01-01).
  const expiration = buf.length >= 48 ? buf.readDoubleLE(40) : 0

  const name = readCString(buf, nameOffset, size)
  if (!name) {
    return null
  }
  const value = readCString(buf, valueOffset, size) ?? ''
  const path = readCString(buf, pathOffset, size) ?? '/'
  const rawUrl = readCString(buf, urlOffset, size) ?? ''

  // Why: Safari stores the domain in the URL field, not as a separate domain column.
  const domain = rawUrl.startsWith('.') ? rawUrl : rawUrl || null
  if (!domain) {
    return null
  }

  const url = deriveUrl(domain, secure)
  if (!url) {
    return null
  }

  const expirationDate = expiration > 0 ? Math.round(expiration + MAC_EPOCH_DELTA) : undefined

  return {
    url,
    name,
    value,
    domain,
    path,
    hostOnly: !domain.startsWith('.'),
    secure,
    httpOnly,
    sameSite: 'unspecified',
    expirationDate
  }
}

function readCString(buf: Buffer, offset: number, end: number): string | null {
  if (offset < 0 || offset >= end) {
    return null
  }
  let cursor = offset
  while (cursor < end && buf[cursor] !== 0) {
    cursor++
  }
  if (cursor >= end) {
    return null
  }
  return buf.toString('utf8', offset, cursor)
}

// ---------------------------------------------------------------------------
// Firefox import
// ---------------------------------------------------------------------------

async function importCookiesFromFirefox(
  browser: DetectedBrowser,
  targetPartition: string,
  cookieImportScope?: ResolvedCookieImportScope | null
): Promise<BrowserCookieImportResult> {
  diag(`importCookiesFromFirefox: partition="${targetPartition}"`)

  const tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-import-'))
  const tmpCookiesPath = join(tmpDir, 'cookies.sqlite')

  try {
    copyFileSync(browser.cookiesPath, tmpCookiesPath)
    for (const suffix of ['-wal', '-shm'] as const) {
      const sidecar = browser.cookiesPath + suffix
      if (existsSync(sidecar)) {
        try {
          copyFileSync(sidecar, tmpCookiesPath + suffix)
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    rmSync(tmpDir, { recursive: true, force: true })
    return {
      ok: false,
      reason: 'Could not copy Firefox cookies database. Try closing Firefox first.'
    }
  }

  try {
    const db = new DatabaseSync(tmpCookiesPath, { readOnly: true })
    type FirefoxRow = {
      name: string
      value: string
      host: string
      path: string
      expiry: number
      isSecure: number
      isHttpOnly: number
      sameSite: number
    }
    const rows = db
      .prepare(
        'SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies'
      )
      .all() as FirefoxRow[]
    db.close()

    diag(`  Firefox source has ${rows.length} cookies`)
    if (rows.length === 0) {
      rmSync(tmpDir, { recursive: true, force: true })
      return { ok: false, reason: 'No cookies found in Firefox.' }
    }

    const validated: ValidatedCookie[] = []
    for (const row of rows) {
      if (!row.name || !row.host) {
        continue
      }
      const domain = row.host
      const secure = row.isSecure === 1
      const url = deriveUrl(domain, secure)
      if (!url) {
        continue
      }

      validated.push({
        url,
        name: row.name,
        value: row.value ?? '',
        domain,
        path: row.path || '/',
        hostOnly: !domain.startsWith('.'),
        secure,
        httpOnly: row.isHttpOnly === 1,
        sameSite: firefoxSameSite(row.sameSite),
        expirationDate: row.expiry > 0 ? row.expiry : undefined
      })
    }

    rmSync(tmpDir, { recursive: true, force: true })

    if (validated.length === 0) {
      return { ok: false, reason: 'No valid cookies found in Firefox.' }
    }

    return importValidatedCookies(
      validated,
      rows.length,
      targetPartition,
      cookieImportScope,
      browser.label
    )
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true })
    diag(`  Firefox import failed: ${err}`)
    return {
      ok: false,
      reason: 'Could not import cookies from Firefox. Try closing Firefox first.'
    }
  }
}

// ---------------------------------------------------------------------------
// Safari import
// ---------------------------------------------------------------------------

async function importCookiesFromSafari(
  browser: DetectedBrowser,
  targetPartition: string,
  cookieImportScope?: ResolvedCookieImportScope | null
): Promise<BrowserCookieImportResult> {
  diag(`importCookiesFromSafari: partition="${targetPartition}"`)

  let data: Buffer
  try {
    data = readFileSync(browser.cookiesPath)
  } catch (err) {
    diag(`  Safari read failed: ${err}`)
    // Why: Safari's Cookies.binarycookies lives inside a macOS sandbox container.
    // Reading it requires Full Disk Access in System Settings → Privacy & Security.
    const isPermError =
      err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EPERM'
    if (isPermError) {
      return {
        ok: false,
        reason:
          'macOS denied access to Safari cookies. Grant Full Disk Access to Orca in System Settings → Privacy & Security → Full Disk Access.'
      }
    }
    return { ok: false, reason: 'Could not read Safari cookies.' }
  }

  try {
    const cookies = decodeSafariBinaryCookies(data)
    diag(`  Safari source has ${cookies.length} cookies`)

    if (cookies.length === 0) {
      return { ok: false, reason: 'No cookies found in Safari.' }
    }

    const now = Math.floor(Date.now() / 1000)
    const valid = cookies.filter((c) => !c.expirationDate || c.expirationDate > now)

    if (valid.length === 0) {
      return { ok: false, reason: 'All Safari cookies are expired.' }
    }

    return importValidatedCookies(
      cookies,
      cookies.length,
      targetPartition,
      cookieImportScope,
      browser.label
    )
  } catch (err) {
    diag(`  Safari import failed: ${err}`)
    return { ok: false, reason: 'Could not import cookies from Safari.' }
  }
}

// ---------------------------------------------------------------------------
// Import dispatcher
// ---------------------------------------------------------------------------

export async function importCookiesFromBrowser(
  browser: DetectedBrowser,
  targetPartition: string,
  webAiProvider?: WebAiProvider,
  cookieImportScope?: BrowserCookieImportScope
): Promise<BrowserCookieImportResult> {
  const scopeResolution = resolveCookieImportScope(webAiProvider, cookieImportScope)
  if (!scopeResolution.ok) {
    return scopeResolution
  }
  const resolvedCookieImportScope = scopeResolution.scope
  diag(`importCookiesFromBrowser: browser=${browser.family} partition="${targetPartition}"`)
  if (!existsSync(browser.cookiesPath)) {
    diag(`  cookies DB not found: ${browser.cookiesPath}`)
    return { ok: false, reason: `${browser.label} cookies database not found.` }
  }

  if (browser.family === 'firefox') {
    return importCookiesFromFirefox(browser, targetPartition, resolvedCookieImportScope)
  }
  if (browser.family === 'safari') {
    return importCookiesFromSafari(browser, targetPartition, resolvedCookieImportScope)
  }

  // Why: Electron's cookies.set() API rejects many valid cookie values (binary
  // bytes > 0x7F etc). Instead, decrypt from the source browser and write
  // plaintext directly to the SQLite `value` column. CookieMonster reads
  // `value` as a raw byte string when `encrypted_value` is empty, bypassing
  // all API-level validation. This works because Electron's CookieMonster in
  // dev mode does not use os_crypt encryption — it stores cookies as plaintext.
  // In packaged builds where os_crypt IS active, CookieMonster will re-encrypt
  // plaintext cookies on its next flush, so this approach is safe in both modes.

  // Why: CookieMonster holds the live DB's data in memory and overwrites it
  // on flush/shutdown. Writing directly to the live DB is futile. Instead,
  // copy the live DB to a staging location, populate it there, and let the
  // next cold start swap it in before CookieMonster initializes.
  const targetSession = session.fromPartition(targetPartition)
  await targetSession.cookies.flushStore()

  const partitionName = targetPartition.replace('persist:', '')
  const partitionDir = join(app.getPath('userData'), 'Partitions', partitionName)
  let liveCookiesPath = resolveChromiumCookiesPath(partitionDir)

  // Why: Electron only creates the partition's Cookies SQLite file after the
  // session has actually stored a cookie. For newly created profiles that have
  // never been used by a webview, the file won't exist yet. Setting and
  // removing a throwaway cookie forces Electron to initialize the database.
  if (!liveCookiesPath) {
    try {
      await targetSession.cookies.set({ url: 'https://localhost', name: '__init', value: '1' })
      await targetSession.cookies.remove('https://localhost', '__init')
      await targetSession.cookies.flushStore()
    } catch {
      // ignore — the set/remove may fail but flushStore should still create the file
    }
    liveCookiesPath = resolveChromiumCookiesPath(partitionDir)
  }

  if (!liveCookiesPath) {
    return { ok: false, reason: 'Target cookie database not found. Open a browser tab first.' }
  }

  const stagingDir = join(app.getPath('userData'), 'cookie-import-staging')
  const partitionSegment = partitionName.replace(/[^a-zA-Z0-9_-]/g, '_')
  const stagingCookiesPath = join(
    stagingDir,
    `Cookies-${partitionSegment}-${Date.now()}-${randomUUID()}`
  )
  try {
    mkdirSync(stagingDir, { recursive: true })
    copyFileSync(liveCookiesPath, stagingCookiesPath)
  } catch {
    // Why: copyFile is not atomic and can leave a partial database after an
    // I/O failure, so failed imports must not retain sensitive cookie data.
    try {
      unlinkSync(stagingCookiesPath)
    } catch {
      /* best-effort */
    }
    return { ok: false, reason: 'Could not create staging cookie database.' }
  }

  let sourceSnapshot: ChromiumCookieSnapshot
  try {
    // Why: the browser can commit cookies only to WAL while it remains open;
    // snapshot retries prevent pairing the main DB with a racing WAL generation.
    sourceSnapshot = createChromiumCookieSnapshot(browser.cookiesPath)
  } catch (err) {
    try {
      unlinkSync(stagingCookiesPath)
    } catch {
      /* best-effort */
    }
    diag(`  Chromium snapshot failed: ${err}`)
    return {
      ok: false,
      reason: `Could not copy ${browser.label} cookies database. Try closing ${browser.label} first.`
    }
  }

  let sourceDb: InstanceType<typeof DatabaseSync> | null = null
  let stagingDb: InstanceType<typeof DatabaseSync> | null = null

  try {
    // Why: Chromium stores timestamps as microseconds since 1601, which can exceed
    // Number.MAX_SAFE_INTEGER (~9e15). readBigInts ensures no precision loss.
    sourceDb = new DatabaseSync(sourceSnapshot.databasePath, {
      readOnly: true,
      readBigInts: true
    })
    stagingDb = new DatabaseSync(stagingCookiesPath)

    const targetColumnInfo = stagingDb
      .prepare('PRAGMA table_info(cookies)')
      .all() as ChromiumCookieColumnInfo[]
    const targetCols: string[] = targetColumnInfo.map((r) => r.name)
    const colList = targetCols.join(', ')

    const sourceRows = sourceDb.prepare('SELECT * FROM cookies ORDER BY rowid').all() as Record<
      string,
      unknown
    >[]
    sourceDb.close()
    sourceDb = null

    diag(`  source has ${sourceRows.length} cookies`)

    if (sourceRows.length === 0) {
      stagingDb.close()
      stagingDb = null
      try {
        unlinkSync(stagingCookiesPath)
      } catch {
        /* best-effort */
      }
      return { ok: false, reason: `No cookies found in ${browser.label}.` }
    }

    const scopedSourceRows = sourceRows.filter((sourceRow) => {
      const domain = sourceRow.host_key
      return (
        typeof domain === 'string' && cookieMatchesImportScope(domain, resolvedCookieImportScope)
      )
    })
    const now = Date.now() / 1000
    const expiredSourceRows = scopedSourceRows.filter((sourceRow) => {
      const expiresUtc = chromiumTimestampToUnix(sourceRow.expires_utc as bigint)
      return expiresUtc > 0 && expiresUtc <= now
    })
    const unexpiredSourceRows = scopedSourceRows.filter((sourceRow) => {
      const expiresUtc = chromiumTimestampToUnix(sourceRow.expires_utc as bigint)
      return expiresUtc <= 0 || expiresUtc > now
    })
    const importSourceRows = unexpiredSourceRows.filter((sourceRow) => {
      const domain = sourceRow.host_key
      const name = sourceRow.name
      return !(
        typeof domain === 'string' &&
        typeof name === 'string' &&
        isGoogleIntegrityCookie(name, domain)
      )
    })
    const integritySkipped = unexpiredSourceRows.length - importSourceRows.length
    const expiredSkipped = expiredSourceRows.length
    const protectedCookieIds = new Set(
      expiredSourceRows.flatMap((sourceRow) => {
        const domain = sourceRow.host_key
        const name = sourceRow.name
        const path = sourceRow.path
        return typeof domain === 'string' && typeof name === 'string' && typeof path === 'string'
          ? [sessionCookieIdentity({ domain, name, path })]
          : []
      })
    )

    if (importSourceRows.length === 0) {
      stagingDb.close()
      stagingDb = null
      try {
        unlinkSync(stagingCookiesPath)
      } catch {
        /* best-effort */
      }
      return {
        ok: false,
        reason: resolvedCookieImportScope
          ? noMatchingCookiesReason(resolvedCookieImportScope, browser.label)
          : 'No importable cookies found.'
      }
    }

    const needsSourceKey = importSourceRows.some((sourceRow) => {
      const encRaw = sourceRow.encrypted_value
      return encRaw instanceof Uint8Array && encRaw.length > 0
    })
    const sourceKey = needsSourceKey
      ? getEncryptionKey(browser.keychainService!, browser.keychainAccount!, browser)
      : null
    if (needsSourceKey && !sourceKey) {
      stagingDb.close()
      stagingDb = null
      // Why: key denial happens after staging, so failed retries must not leave
      // one full target database copy behind each time.
      try {
        unlinkSync(stagingCookiesPath)
      } catch {
        /* best-effort */
      }
      return {
        ok: false,
        reason: `Could not access ${browser.label} encryption key. The OS may have denied access.`
      }
    }

    let imported = 0
    let skipped = sourceRows.length - importSourceRows.length
    let preparationFailures = 0
    let memoryLoaded = 0
    let memoryFailed = 0
    const domainSet = new Set<string>()

    type DecryptedCookie = {
      decryptedValue: Buffer
      value: string
      domain: string
      name: string
      path: string
      hostOnly: boolean
      secure: boolean
      httpOnly: boolean
      sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
      expirationDate: number | undefined
    }

    const decryptedCookies: DecryptedCookie[] = []

    const placeholders = targetCols.map(() => '?').join(', ')
    const insertStmt = stagingDb.prepare(
      `INSERT OR REPLACE INTO cookies (${colList}) VALUES (${placeholders})`
    )

    stagingDb.exec('BEGIN TRANSACTION')
    if (resolvedCookieImportScope) {
      const deleted = deleteStagedCookiesMatchingScope(stagingDb, resolvedCookieImportScope)
      diag(`  removed ${deleted} scoped cookies from staging database`)
    } else {
      stagingDb.exec('DELETE FROM cookies')
    }

    for (const sourceRow of importSourceRows) {
      const encRaw = sourceRow.encrypted_value
      // Why: node:sqlite returns BLOB columns as Uint8Array. Any other truthy type
      // means the schema is unexpected — treat it as missing rather than creating
      // an empty buffer that would silently produce a blank cookie value.
      const encBuf = encRaw instanceof Uint8Array ? Buffer.from(encRaw) : null
      const plainRaw = sourceRow.value

      let decryptedValue: Buffer
      if (encBuf && encBuf.length > 0) {
        const raw = sourceKey ? decryptCookieValueRaw(encBuf, sourceKey) : null
        if (!raw) {
          skipped++
          preparationFailures++
          continue
        }
        decryptedValue = raw
      } else if (plainRaw instanceof Uint8Array) {
        decryptedValue = Buffer.from(plainRaw)
      } else if (typeof plainRaw === 'string') {
        decryptedValue = Buffer.from(plainRaw, 'latin1')
      } else {
        decryptedValue = Buffer.alloc(0)
      }

      const domain = sourceRow.host_key as string
      const name = sourceRow.name as string

      const cleanDomain = domain.startsWith('.') ? domain.slice(1) : domain
      domainSet.add(cleanDomain)

      const path = sourceRow.path as string
      const secure = sourceRow.is_secure === 1n
      const httpOnly = sourceRow.is_httponly === 1n
      const sameSite = chromiumSameSite(Number(sourceRow.samesite ?? 0))
      const expiresUtc = chromiumTimestampToUnix(sourceRow.expires_utc as bigint)
      // Why: cookie values are raw byte strings, not UTF-8 text. Using latin1
      // (ISO-8859-1) preserves all byte values 0x00–0xFF without replacement
      // characters that UTF-8 decoding would insert for invalid sequences.
      const value = decryptedValue.toString('latin1')

      decryptedCookies.push({
        decryptedValue,
        value,
        domain,
        name,
        path,
        hostOnly: !domain.startsWith('.'),
        secure,
        httpOnly,
        sameSite,
        expirationDate: expiresUtc > 0 ? expiresUtc : undefined
      })

      const params = buildChromiumCookieInsertParams(targetColumnInfo, sourceRow, decryptedValue)
      insertStmt.run(...params)
      imported++
    }
    diag(`  skipped ${integritySkipped} Google integrity cookies (SIDCC/STRP/AEC)`)
    diag(`  skipped ${expiredSkipped} expired cookies`)

    if (resolvedCookieImportScope && preparationFailures > 0) {
      stagingDb.exec('ROLLBACK')
      stagingDb.close()
      stagingDb = null
      try {
        unlinkSync(stagingCookiesPath)
      } catch {
        /* best-effort */
      }
      return {
        ok: false,
        reason: `Could not prepare all ${resolvedCookieImportScope.label} cookies from ${browser.label}.`
      }
    }

    if (imported === 0) {
      stagingDb.exec('ROLLBACK')
      stagingDb.close()
      stagingDb = null
      try {
        unlinkSync(stagingCookiesPath)
      } catch {
        /* best-effort */
      }
      return {
        ok: false,
        reason: resolvedCookieImportScope
          ? `No ${resolvedCookieImportScope.label} cookies could be prepared from ${browser.label}.`
          : `No cookies could be prepared from ${browser.label}.`
      }
    }

    stagingDb.exec('COMMIT')
    stagingDb.close()
    stagingDb = null

    diag(`  SQLite staging complete: ${imported} cookies, ${domainSet.size} domains`)

    if (resolvedCookieImportScope) {
      const replacement = await replaceScopedSessionCookies(
        targetSession,
        resolvedCookieImportScope,
        decryptedCookies,
        protectedCookieIds
      )
      if (!replacement.ok) {
        try {
          unlinkSync(stagingCookiesPath)
        } catch {
          /* best-effort */
        }
        return replacement
      }
      memoryLoaded = replacement.imported
    } else {
      // Why: full-profile import keeps its existing replace-all semantics to
      // avoid mixing old and imported authentication state.
      await targetSession.clearStorageData({ storages: ['cookies'] })
      diag(
        `  cleared existing session cookies before loading ${decryptedCookies.length} imported cookies`
      )
      // Why: full-profile import retains the cold-start SQLite fallback for
      // values Electron cannot accept through cookies.set(). Scoped imports use
      // the transactional path above so an apparent failure cannot sign out an
      // existing account.
      for (const cookie of decryptedCookies) {
        if (await setSessionCookie(targetSession, cookie)) {
          memoryLoaded++
        } else {
          memoryFailed++
        }
      }
    }

    diag(`  memory load: ${memoryLoaded} OK, ${memoryFailed} failed`)

    if (memoryFailed > 0) {
      // Why: some cookies couldn't be loaded via cookies.set() (non-ASCII values
      // or other validation failures). Keep the staging DB so the next cold start
      // picks them up from SQLite where CookieMonster reads them without validation.
      browserSessionRegistry.setPendingCookieImport(targetPartition, stagingCookiesPath)
      diag(`  staged at ${stagingCookiesPath} for ${memoryFailed} cookies that need restart`)
    } else {
      try {
        unlinkSync(stagingCookiesPath)
      } catch {
        /* best-effort */
      }
      diag(`  all cookies loaded in-memory — no restart needed`)
    }

    const ua = getUserAgentForBrowser(browser.family)
    if (ua) {
      targetSession.setUserAgent(ua)
      setupClientHintsOverride(targetSession, ua)
      browserSessionRegistry.persistUserAgent(targetPartition, ua)
      diag(`  set UA for partition: ${ua.substring(0, 80)}...`)
    }

    const summary: BrowserCookieImportSummary = {
      totalCookies: sourceRows.length,
      importedCookies: imported,
      skippedCookies: skipped,
      domains: [...domainSet].sort()
    }

    return { ok: true, profileId: '', summary }
  } catch (err) {
    try {
      sourceDb?.close()
    } catch {
      /* may already be closed */
    }
    try {
      stagingDb?.close()
    } catch {
      /* may already be closed */
    }
    // Why: if the import fails after the staging DB was created, clean it up
    // to avoid a stale staged import being applied on the next cold start.
    try {
      unlinkSync(stagingCookiesPath)
    } catch {
      /* may not exist yet */
    }
    diag(`  SQLite import failed: ${err}`)
    return {
      ok: false,
      reason: reasonWithDiagLog(
        `Could not import cookies from ${browser.label}: ${summarizeCookieImportError(err)}.`
      )
    }
  } finally {
    try {
      sourceSnapshot.cleanup()
    } catch (err) {
      diag(`  Chromium snapshot cleanup failed: ${err}`)
    }
  }
}
