/* eslint-disable max-lines -- Why: cookie import is one pipeline (detect → decrypt → stage → swap) that must stay together to keep encryption/schema/staging in sync. */
import { app, type BrowserWindow, dialog, session } from 'electron'
import { execFileSync } from 'node:child_process'
import { runProcessSync } from '../../shared/child-process/run-process'
import { windowsPowerShellPath } from '../../shared/child-process/windows-system-binary'
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

// Why: write the diag log to userData, not world-readable /tmp, so only the current user can read it.
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

// Why: error messages can embed large pasted/file payloads; cap the scan since diagnostics only need a short preview.
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
  BrowserCookieImportResult,
  BrowserCookieImportSummary,
  BrowserSessionProfileSource
} from '../../shared/browser-workspace-types'
import { browserSessionRegistry } from './browser-session-registry'
import { supportsPendingBrowserCookieImportReplay } from './browser-session-cookie-staging'
import {
  isGoogleSourceBoundCookie,
  isNonTransplantableCookieDomain,
  normalizeCookieDomain,
  normalizeCookieImportDomain,
  importedDomainScope,
  replaceCookiesForImportedDomains,
  type CookieImportMode,
  type ReplacedImportedDomainCookies
} from './browser-cookie-import-policy'
import {
  acquireCookieMutationLock,
  removeTransplantableCookies,
  withCookieMutationLock,
  type CookieClearStore,
  type CookieImportWriteStore
} from './browser-cookie-import-clear'
import { openCookieClearStore } from './browser-cookie-clear-store'
import {
  readChromiumRowPartition,
  readFirefoxRowPartition,
  readJsonCookiePartition,
  type SourcePartitionRead
} from './browser-cookie-source-partition'
import {
  emptyImportWritePhase,
  writeImportedCookies,
  type ImportedCookieFields,
  type ImportWritePhase,
  type SourceCookieToWrite,
  planImportWrites
} from './browser-cookie-import-write'
import {
  createChromiumCookieSnapshot,
  type ChromiumCookieSnapshot
} from './chromium-cookie-snapshot'
import { resolveChromiumCookiesPath } from './chromium-cookie-path'
import { prepareStagedCookiesForImport } from './browser-cookie-staged-import'
import { copyFileWithWindowsRetry } from '../codex-accounts/fs-utils'

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
  // Per-platform data-dir roots, resolved at detection time via browserRootPath().
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
    // Why: Helium breaks the '<Browser> Safe Storage' convention — its Keychain service is literally 'Helium Storage Key'.
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

// Why: Chrome's Local State profile.info_cache maps profile dirs to display names for the picker.
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
    // Why: Firefox dirs are named <random>.<name>; prefer 'default-release' as the primary profile on most installs.
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
    // Why: a browser counts as detected once a profile has a cookies DB; use the first such profile as default.
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
  secure?: unknown
  httpOnly?: unknown
  sameSite?: unknown
  expirationDate?: unknown
  partitionKey?: unknown
  partitionKeyOpaque?: unknown
}

// Why (STA-4300): `partition` is required, not optional, so every source that builds a cookie has to
// state what it read. An optional field would let a new source silently default to unpartitioned.
type ValidatedCookie = ImportedCookieFields & {
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  partition: SourcePartitionRead
}

// Why: Chromium's CookieSameSiteForStorage enum (0=Unspecified,1=None,2=Lax,3=Strict) differs from Firefox's numbering.
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

// Why: a cookie identity needs a url to scope it; derive it from domain + secure flag.
function deriveUrl(domain: string, secure: boolean): string | null {
  const normalizedDomain = normalizeCookieDomain(domain)
  if (!normalizedDomain) {
    return null
  }
  const protocol = secure ? 'https' : 'http'
  try {
    const url = new URL(`${protocol}://${normalizedDomain}/`)
    return url.toString()
  } catch {
    return null
  }
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
    secure,
    httpOnly: raw.httpOnly === true || raw.httpOnly === 1,
    sameSite: normalizeSameSite(raw.sameSite),
    expirationDate,
    partition: readJsonCookiePartition(raw.partitionKey, raw.partitionKeyOpaque)
  }
}

// Why (STA-4300): the import writes get a store with no `set` on it and no Session behind it, so
// the partition-dropping write is not merely unused here — it cannot be reached.
type CookieImportSessionStore = CookieClearStore & CookieImportWriteStore & { dispose: () => void }

type CookieImportTarget = {
  partition: string
  // Why (STA-4601): the live-jar lock is keyed on an object, and this path no longer holds the
  // Session that STA-4300 moved behind openWriteStore. session.fromPartition returns the SAME
  // instance for one partition string, so carrying that instance here is what keeps this path's
  // lock and the native path's lock on ONE key — a fresh object per call would serialise nothing.
  mutationLockOwner: object
  openWriteStore: () => CookieImportSessionStore
}

type CookieImportOptions = {
  canReportPartitionSkippedCookies?: boolean
}

function cookieImportTarget(targetPartition: string): CookieImportTarget {
  const targetSession = session.fromPartition(targetPartition)
  return {
    partition: targetPartition,
    mutationLockOwner: targetSession,
    openWriteStore: () => openCookieClearStore(targetSession)
  }
}

async function importValidatedCookies(
  cookies: ValidatedCookie[],
  totalInput: number,
  target: CookieImportTarget,
  mode: CookieImportMode,
  options: CookieImportOptions = {}
): Promise<BrowserCookieImportResult> {
  const targetPartition = target.partition
  const importDomainCache = new Map<string, boolean>()
  const validDomainCookies = cookies.filter((cookie) => {
    let valid = importDomainCache.get(cookie.domain)
    if (valid === undefined) {
      valid = normalizeCookieImportDomain(cookie.domain) !== null
      importDomainCache.set(cookie.domain, valid)
    }
    return valid
  })
  const sourceBoundFiltered = validDomainCookies.filter(
    (cookie) => !isGoogleSourceBoundCookie(cookie.name, cookie.domain)
  )
  // Why: dropping these before the replace scope is computed is what keeps the existing
  // Google session intact — replaceCookiesForImportedDomains only clears domains we import.
  const importableCookies = sourceBoundFiltered.filter(
    (cookie) => !isNonTransplantableCookieDomain(cookie.domain)
  )
  const integritySkipped = validDomainCookies.length - sourceBoundFiltered.length
  const nonTransplantableSkipped = sourceBoundFiltered.length - importableCookies.length
  const googleCookiesSkipped = integritySkipped + nonTransplantableSkipped
  const invalidDomainSkipped = cookies.length - validDomainCookies.length
  diag(
    `importValidatedCookies: ${cookies.length} validated, ${invalidDomainSkipped} unsafe-domain skipped, ${integritySkipped} source-bound skipped, ${nonTransplantableSkipped} non-transplantable skipped of ${totalInput} total, partition="${targetPartition}"`
  )
  // Why (STA-4300 I1): every cookie's fate is decided here, before the jar is opened. The plan is
  // the single value the write set AND the removal scope both derive from, so they cannot drift
  // apart the way they did in bf6dc6fcba.
  const plan = planImportWrites(importableCookies)

  // Why (§4.3c): a family we cannot name is one we cannot exclude from the removal scope, and
  // clearing a family we cannot protect is the P0. Refuse before touching anything.
  if (plan.hasUnrepresentableSkip) {
    return {
      ok: false,
      reason:
        'Could not import: a cookie with an unreadable site partition has no registrable domain, so its existing session cannot be protected.'
    }
  }

  // Why: an older remote client cannot surface this skip, so fail before opening the target jar.
  if (options.canReportPartitionSkippedCookies === false && plan.skips.length > 0) {
    return {
      ok: false,
      reason:
        'This Orca client cannot report cookies skipped for an unreadable site partition. Update Orca on this device and try again.'
    }
  }
  // Why: a family-suppressed sibling is a partition skip too, so partitionSkippedCookies is a
  // BREAKDOWN of skippedCookies and is added into it exactly once — never a separate addend, or
  // totalCookies === importedCookies + skippedCookies silently stops holding.
  const partitionSkipped = plan.skips.length
  let skipped = totalInput - importableCookies.length + partitionSkipped
  let phase: ImportWritePhase = emptyImportWritePhase()
  // Why (STA-4097/STA-4300): both the rollback and the import writes need CDP identities — only
  // they carry partitionKey. cookies.set drops it silently, on the success path as well.
  const cookieClearStore = plan.writes.length > 0 ? target.openWriteStore() : null

  if (cookieClearStore) {
    // Why (STA-4601): the replace, the writes, and the rollback are one live-jar transaction.
    // Releasing after the replace lets a second import interleave, so this run's rollback could
    // remove cookies the newer import already wrote and reported as imported. Taken AFTER the
    // store is opened on purpose — openWriteStore only builds the adapter, it attaches no
    // debugger, so holding it while queued cannot deadlock against the holder.
    const releaseMutationLock = await acquireCookieMutationLock(target.mutationLockOwner)
    let replaced: ReplacedImportedDomainCookies | null = null
    try {
      if (mode === 'replace-imported-domains') {
        try {
          // Why (STA-4300 I2 / §2b): the removal scope is the write set. Filtering per exact
          // cookie is NOT enough — replaceCookiesForImportedDomains expands each imported domain
          // into its descendant roots, so a readable apex cookie would drag a skipped subdomain's
          // live session into the removal scope with nothing written back. plan.writes is already
          // family-closed, and using the same array for both makes them impossible to diverge.
          const replacementDomains = plan.writes.map((cookie) => cookie.domain)
          replaced = await replaceCookiesForImportedDomains(cookieClearStore, replacementDomains)
          diag(`  removed ${replaced.removed.length} existing cookies in imported domain scopes`)
        } catch (err) {
          diag(`  existing cookie replacement failed: ${summarizeCookieImportError(err)}`)
          return {
            ok: false,
            reason: reasonWithDiagLog('Could not replace existing cookies for the imported sites.')
          }
        }
      }

      // Why: Chromium rejects any non-printable-ASCII byte in a cookie value; strip as a safety net.
      const stripNonPrintable = (s: string): string => s.replace(/[^\x20-\x7E]/g, '')
      phase = await writeImportedCookies(
        cookieClearStore,
        plan.writes.map((cookie) => ({ ...cookie, value: stripNonPrintable(cookie.value) })),
        { stopOnFailure: replaced !== null, log: diag }
      )
      // Why: plan.skips holds every partition-driven skip — the unreadable rows AND the readable
      // siblings suppressed by family closure. phase.partitionSkipped is 0 now that only planned
      // writes reach the writer, so the count comes from the plan and is added exactly once.
      skipped += phase.writeRejected

      if (phase.failure && replaced) {
        const rollbackFailures: unknown[] = []
        for (const cookie of phase.attemptedKeys.toReversed()) {
          try {
            await cookieClearStore.remove(cookie.url, cookie.name)
          } catch (err) {
            rollbackFailures.push(err)
          }
        }
        // Why: restoreClearIdentities attaches the debugger before it iterates, so an empty
        // restore set would spin up a hidden BrowserWindow to put nothing back.
        if (replaced.identities.length > 0) {
          try {
            await cookieClearStore.restoreClearIdentities(replaced.identities.toReversed())
          } catch (err) {
            rollbackFailures.push(err)
          }
        }
        if (rollbackFailures.length > 0) {
          diag(`  cookie replacement rollback failed: ${rollbackFailures.length} operation(s)`)
        }
        return {
          ok: false,
          reason: reasonWithDiagLog('Could not safely replace cookies for the imported sites.')
        }
      }
    } finally {
      try {
        cookieClearStore.dispose()
      } finally {
        releaseMutationLock()
      }
    }
  }

  diag(
    `importValidatedCookies result: imported=${phase.importedCount} skipped=${skipped} partition-unreadable=${partitionSkipped} domains=${phase.domains.size}`
  )

  const summary: BrowserCookieImportSummary = {
    totalCookies: totalInput,
    importedCookies: phase.importedCount,
    skippedCookies: skipped,
    ...(googleCookiesSkipped > 0 ? { googleCookiesSkipped } : {}),
    ...(partitionSkipped > 0 ? { partitionSkippedCookies: partitionSkipped } : {}),
    domains: [...phase.domains].sort()
  }

  return { ok: true, profileId: '', summary }
}

// ---------------------------------------------------------------------------
// Import from JSON file
// ---------------------------------------------------------------------------

// Why: use a main-owned native dialog so a compromised renderer can't turn import into arbitrary file reads.
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
  targetPartition: string
): Promise<BrowserCookieImportResult> {
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
    cookieImportTarget(targetPartition),
    'replace-imported-domains'
  )
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

// Why: each platform protects the Chromium key differently: macOS/Linux PBKDF2→AES-128-CBC, Windows DPAPI→AES-256-GCM.

type EncryptionKeyResult =
  | {
      mode: 'aes-128-cbc'
      keysByVersion: Partial<Record<'v10' | 'v11', Buffer>>
      keyringUnavailable?: boolean
    }
  | { mode: 'aes-256-gcm'; key: Buffer }

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

    const sourceHasColumn = Object.hasOwn(sourceRow, column.name)
    const sourceValue = sourceHasColumn ? normalizeSqliteCookieValue(sourceRow[column.name]) : null
    if (sourceValue !== null) {
      return sourceValue
    }
    if (sourceHasColumn && !isSqliteNotNull(column)) {
      return null
    }

    // Why: cookie columns drift across Chrome/Electron versions; missing NOT NULL columns need Chromium defaults, not NULL.
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
      mode: 'aes-128-cbc',
      keysByVersion: {
        v10: pbkdf2Sync(raw, PBKDF2_SALT, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha1')
      }
    }
  } catch {
    return null
  }
}

function getLinuxEncryptionKey(
  keychainService: string,
  keychainAccount: string
): EncryptionKeyResult | null {
  // Chromium uses v11 only with OS key storage; without it, Linux writes v10 with hardcoded
  // "peanuts". Keep eligibility explicit because CBC cannot authenticate a wrong-key result.
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
      diag('  Linux keyring unavailable — v11 cookies cannot be decrypted')
    }
  }

  if (!keyringPassword) {
    return {
      mode: 'aes-128-cbc',
      keysByVersion: { v10: v10Key },
      keyringUnavailable: true
    }
  }

  const v11Key = pbkdf2Sync(keyringPassword, PBKDF2_SALT, 1, PBKDF2_KEY_LENGTH, 'sha1')
  return { mode: 'aes-128-cbc', keysByVersion: { v10: v10Key, v11: v11Key } }
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

    // Why: PowerShell DPAPI decrypt is the only native-addon-free path to the master key; pass via stdin to avoid injection.
    const dpapiData = encryptedKey.subarray(dpapiPrefix.length).toString('base64')
    const script = [
      'try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop }',
      'catch { try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch {} };',
      '$in=[Convert]::FromBase64String([Console]::In.ReadLine());',
      '$out=[System.Security.Cryptography.ProtectedData]::Unprotect($in,$null,',
      '[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '[Convert]::ToBase64String($out)'
    ].join('')

    // Why runProcessSync and an absolute path: a bare `powershell` spawn from a
    // GUI-subsystem process opens a visible conhost that takes foreground, so
    // keystrokes typed into an Orca terminal during a cookie import land in the
    // black box (#14543), and PATH under Electron is not the user's (#11771).
    const result = runProcessSync({
      program: windowsPowerShellPath(),
      args: ['-NoProfile', '-NonInteractive', '-Command', script],
      timeoutMs: 10_000,
      input: dpapiData
    })
    if (result.code !== 0 || result.timedOut) {
      diag('  Windows DPAPI key extraction failed: PowerShell exited non-zero')
      return null
    }

    return { key: Buffer.from(result.stdout.trim(), 'base64'), mode: 'aes-256-gcm' }
  } catch (err) {
    diag(`  Windows DPAPI key extraction failed: ${String(err)}`)
    return null
  }
}

// Why: Chromium 127+ prepends a 32-byte HMAC before the value; a hash is ~half non-printable, so ≥8 non-printable of the first 32 bytes flags the prefix.
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

// Why: the version prefix is the only thing that survives a failed decrypt, so read it once and
// share it between the decrypt path and the failure attribution.
function cookieEncryptionVersion(encryptedBuffer: Buffer): string | null {
  if (encryptedBuffer.length < 3) {
    return null
  }
  const version = encryptedBuffer.subarray(0, 3).toString('utf-8')
  return /^v\d\d$/.test(version) ? version : null
}

// Why: Chrome/Edge 140+ on Windows prefix every cookie with `v20` (app-bound encryption), which
// only the writing browser can unwrap. Classify it before decrypt so it is not folded into corruption.
export function isAppBoundEncryptedCookie(encryptedBuffer: Buffer): boolean {
  return cookieEncryptionVersion(encryptedBuffer) === 'v20'
}

// Why: a named cause must carry only its exact count; tied causes fall back to unknown.
function buildUndecryptableWarning(counts: {
  decryptFailed: number
  appBoundFailed: number
  keyringUnavailableFailed: number
}): BrowserCookieImportSummary['warning'] {
  if (counts.decryptFailed === 0) {
    return undefined
  }
  const unknownFailed =
    counts.decryptFailed - counts.appBoundFailed - counts.keyringUnavailableFailed
  const rankedCauses = [
    { reason: 'app-bound-encryption' as const, count: counts.appBoundFailed },
    { reason: 'linux-keyring-unavailable' as const, count: counts.keyringUnavailableFailed },
    { reason: 'unknown' as const, count: unknownFailed }
  ].sort((left, right) => right.count - left.count)
  const [dominant, runnerUp] = rankedCauses

  if (dominant.reason === 'unknown' || dominant.count === runnerUp.count) {
    return { code: 'cookies-undecryptable', failedCookies: counts.decryptFailed, reason: 'unknown' }
  }

  const otherFailedCookies = counts.decryptFailed - dominant.count
  return {
    code: 'cookies-undecryptable',
    failedCookies: dominant.count,
    reason: dominant.reason,
    ...(otherFailedCookies > 0 ? { otherFailedCookies } : {})
  }
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
  const key = version === 'v10' || version === 'v11' ? keyResult.keysByVersion[version] : undefined
  if (!key) {
    return null
  }

  const ciphertext = encryptedBuffer.subarray(3)
  if (!ciphertext.length) {
    return null
  }

  try {
    const iv = Buffer.alloc(16, ' ')
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    decipher.setAutoPadding(true)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return stripHmac(decrypted)
  } catch {
    return null
  }
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
  // Why: pages can hold large cookie lists; push per-item to avoid exceeding the spread argument limit.
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
  // Why: size comes from the file and could be attacker-controlled; clamp so readCString can't escape the subarray.
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
    secure,
    httpOnly,
    sameSite: 'unspecified',
    expirationDate,
    // Why: Cookies.binarycookies has no partition field — Safari's format predates CHIPS, so every
    // decoded cookie is genuinely unpartitioned rather than missing an identity.
    partition: { status: 'unpartitioned' }
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
  options: CookieImportOptions
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
    type FirefoxRow = Record<string, unknown> & {
      name: string
      value: string
      host: string
      path: string
      expiry: number
      isSecure: number
      isHttpOnly: number
      sameSite: number
      isPartitionedAttributeSet?: number
    }
    // Why: selecting a column an older moz_cookies schema lacks fails the whole import. A schema
    // without the server-declared partition flag predates that cookie identity.
    const firefoxColumns = new Set(
      (db.prepare('PRAGMA table_info(moz_cookies)').all() as { name: string }[]).map(
        (column) => column.name
      )
    )
    const partitionColumn = firefoxColumns.has('isPartitionedAttributeSet')
      ? ', isPartitionedAttributeSet'
      : ''
    const rows = db
      .prepare(
        `SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite${partitionColumn} FROM moz_cookies`
      )
      .all() as FirefoxRow[]
    db.close()

    diag(`  Firefox source has ${rows.length} cookies`)
    if (rows.length === 0) {
      rmSync(tmpDir, { recursive: true, force: true })
      return { ok: false, reason: 'No cookies found in Firefox.' }
    }

    const now = Math.floor(Date.now() / 1000)
    const validated: ValidatedCookie[] = []
    for (const row of rows) {
      if (!row.name || !row.host) {
        continue
      }
      if (row.expiry > 0 && row.expiry < now) {
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
        secure,
        httpOnly: row.isHttpOnly === 1,
        sameSite: firefoxSameSite(row.sameSite),
        expirationDate: row.expiry > 0 ? row.expiry : undefined,
        partition: readFirefoxRowPartition(row, firefoxColumns)
      })
    }

    rmSync(tmpDir, { recursive: true, force: true })

    if (validated.length === 0) {
      return { ok: false, reason: 'No valid cookies found in Firefox.' }
    }

    return importValidatedCookies(
      validated,
      rows.length,
      cookieImportTarget(targetPartition),
      'replace-imported-domains',
      options
    )
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true })
    diag(`  Firefox import failed: ${String(err)}`)
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
  targetPartition: string
): Promise<BrowserCookieImportResult> {
  diag(`importCookiesFromSafari: partition="${targetPartition}"`)

  let data: Buffer
  try {
    data = readFileSync(browser.cookiesPath)
  } catch (err) {
    diag(`  Safari read failed: ${String(err)}`)
    // Why: Safari's Cookies.binarycookies is in a sandbox container; reading it needs Full Disk Access.
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
      valid,
      cookies.length,
      cookieImportTarget(targetPartition),
      'replace-imported-domains'
    )
  } catch (err) {
    diag(`  Safari import failed: ${String(err)}`)
    return { ok: false, reason: 'Could not import cookies from Safari.' }
  }
}

// ---------------------------------------------------------------------------
// Import dispatcher
// ---------------------------------------------------------------------------

export async function importCookiesFromBrowser(
  browser: DetectedBrowser,
  targetPartition: string,
  options: CookieImportOptions = {}
): Promise<BrowserCookieImportResult> {
  diag(`importCookiesFromBrowser: browser=${browser.family} partition="${targetPartition}"`)
  if (!existsSync(browser.cookiesPath)) {
    diag(`  cookies DB not found: ${browser.cookiesPath}`)
    return { ok: false, reason: `${browser.label} cookies database not found.` }
  }

  if (browser.family === 'firefox') {
    return importCookiesFromFirefox(browser, targetPartition, options)
  }
  if (browser.family === 'safari') {
    return importCookiesFromSafari(browser, targetPartition)
  }

  // Why: cookies.set() rejects many valid values (bytes > 0x7F); instead write plaintext to the `value` column, which CookieMonster reads raw when `encrypted_value` is empty and re-encrypts on flush in packaged builds.

  // Why: CookieMonster can reject otherwise valid imported bytes, so stage a populated copy whose
  // imported-domain rows can be merged into the live DB on the next cold start.
  const targetSession = session.fromPartition(targetPartition)
  // Why (STA-4601): native imports mutate the live jar and their staged image before the old
  // clear/write lock was reached. Hold the per-partition lock from the first flush through staging,
  // live replacement, pending-image bookkeeping, and cleanup so an older image cannot race a newer
  // import on the same partition.
  return withCookieMutationLock(targetSession, async () => {
    await targetSession.cookies.flushStore()

    // Why (STA-4300): ask the Session where its own storage lives instead of rebuilding the path from
    // the caller's partition string. String surgery on a caller-supplied name is what let a value like
    // "persist:../.." resolve a Cookies DB outside the Partitions directory and stage a replacement
    // over it; it also drifts whenever Chromium changes how a partition name maps to a directory.
    const partitionDir = targetSession.getStoragePath()
    if (!partitionDir) {
      return { ok: false, reason: 'Target cookie database not found. Open a browser tab first.' }
    }
    const partitionName = targetPartition.replace('persist:', '')
    let liveCookiesPath = resolveChromiumCookiesPath(partitionDir)

    // Why: Electron creates the Cookies file only after a cookie is stored; a throwaway set/remove forces DB init for unused profiles.
    // Why (STA-4601): this probe MUTATES the live jar, so it runs under the same per-partition lock as
    // the import itself. An earlier revision left it outside on the argument that no import writes
    // https://localhost/__init — that was wrong. normalizeCookieImportDomain accepts `localhost`,
    // cookie names are unrestricted, and deriveUrl produces exactly this URL, so an import CAN write
    // that coordinate. Unlocked, this probe's remove() would delete a cookie a concurrent import had
    // just written and reported as imported. The cost is negligible: the probe only runs for a
    // partition that has never stored a cookie, so it is at most a one-time wait per profile.
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
    // Why: #9355 — staging only backs the cold-restart replay for cookies the in-memory
    // import rejects, so losing it must degrade that fallback rather than abort the import.
    let stagingAvailable = false
    // Why: a client-hosted route partition is derived at runtime and never reaches the startup
    // replay, so staging it would only leave a plaintext cookie DB nothing ever consumes.
    if (!supportsPendingBrowserCookieImportReplay(targetPartition)) {
      diag(
        `  restart fallback unsupported for partition "${targetPartition}" — not staging cookies`
      )
    } else {
      try {
        mkdirSync(stagingDir, { recursive: true })
        copyFileWithWindowsRetry(liveCookiesPath, stagingCookiesPath)
        stagingAvailable = true
      } catch (err) {
        const fsErr = err as NodeJS.ErrnoException
        diag(
          `  staging copy unavailable: code=${fsErr.code ?? 'unknown'} errno=${fsErr.errno ?? 'unknown'} syscall=${fsErr.syscall ?? 'unknown'} path=${liveCookiesPath} destination=${stagingCookiesPath}`
        )
        // Why: copyFile is non-atomic and can leave a partial DB; delete it so failed imports retain no cookie data.
        try {
          unlinkSync(stagingCookiesPath)
        } catch {
          /* best-effort */
        }
      }
    }

    let sourceSnapshot: ChromiumCookieSnapshot
    try {
      // Why: an open browser may hold cookies in WAL only; snapshot retries avoid pairing the main DB with a racing WAL.
      sourceSnapshot = createChromiumCookieSnapshot(browser.cookiesPath)
    } catch (err) {
      try {
        unlinkSync(stagingCookiesPath)
      } catch {
        /* best-effort */
      }
      diag(`  Chromium snapshot failed: ${String(err)}`)
      return {
        ok: false,
        reason: `Could not copy ${browser.label} cookies database. Try closing ${browser.label} first.`
      }
    }

    let sourceDb: InstanceType<typeof DatabaseSync> | null = null
    let stagingDb: InstanceType<typeof DatabaseSync> | null = null
    const closeStagingDb = (): void => {
      try {
        stagingDb?.close()
      } catch {
        /* best-effort */
      }
      stagingDb = null
    }
    const discardStagingFile = (): void => {
      // Why: the staged copy holds plaintext cookie values, and SQLite may have left sidecars beside it.
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          unlinkSync(stagingCookiesPath + suffix)
        } catch {
          /* best-effort */
        }
      }
    }

    try {
      // Why: Chromium timestamps (µs since 1601) can exceed Number.MAX_SAFE_INTEGER; readBigInts avoids precision loss.
      sourceDb = new DatabaseSync(sourceSnapshot.databasePath, {
        readOnly: true,
        readBigInts: true
      })
      let targetColumnInfo: ChromiumCookieColumnInfo[] | null = null
      let colList: string | null = null
      let placeholders: string | null = null
      if (stagingAvailable) {
        // Why: the staged file is Orca's own partition DB, also named "Cookies", so the same
        // transient AV handle can make opening it throw — degrade instead of killing the import.
        try {
          stagingDb = new DatabaseSync(stagingCookiesPath)
          // Why (STA-4797): a new-format stage must be one self-contained file. Otherwise a lost WAL
          // can erase its scope marker and make cold-start replay mistake it for a legacy whole-image
          // import, restoring the unrelated-cookie data loss this format is meant to prevent.
          stagingDb.exec('PRAGMA journal_mode = DELETE')
          targetColumnInfo = stagingDb
            .prepare('PRAGMA table_info(cookies)')
            .all() as ChromiumCookieColumnInfo[]
          const targetCols: string[] = targetColumnInfo.map((r) => r.name)
          colList = targetCols.join(', ')
          placeholders = targetCols.map(() => '?').join(', ')
        } catch (err) {
          diag(`  staging database unusable, restart fallback disabled: ${String(err)}`)
          stagingAvailable = false
          targetColumnInfo = null
          colList = null
          placeholders = null
          closeStagingDb()
          // Why: the copy holds real partition cookies; discard it now rather than at the exit branches.
          discardStagingFile()
        }
      }

      // Why (STA-4300): the partition columns drift across Chromium versions, so read the source
      // schema rather than assuming a row's missing column means "unpartitioned".
      const sourceColumns = new Set(
        (sourceDb.prepare('PRAGMA table_info(cookies)').all() as ChromiumCookieColumnInfo[]).map(
          (column) => column.name
        )
      )
      const sourceRows = sourceDb.prepare('SELECT * FROM cookies ORDER BY rowid').all() as Record<
        string,
        unknown
      >[]
      sourceDb.close()
      sourceDb = null

      diag(`  source has ${sourceRows.length} cookies`)

      if (sourceRows.length === 0) {
        closeStagingDb()
        discardStagingFile()
        return { ok: false, reason: `No cookies found in ${browser.label}.` }
      }

      // Why (STA-4300): partition fidelity is a property of the source row, even when its value
      // cannot be decrypted. Plan first so decryption failure cannot discard a family's skip.
      const partitionCandidates = sourceRows.flatMap((sourceRow) => {
        const domain = sourceRow.host_key as string
        const name = sourceRow.name as string
        return isGoogleSourceBoundCookie(name, domain) || isNonTransplantableCookieDomain(domain)
          ? []
          : [{ sourceRow, domain, partition: readChromiumRowPartition(sourceRow, sourceColumns) }]
      })
      const nativePlan = planImportWrites(partitionCandidates)
      const plannedSourceRows = new Set(nativePlan.writes.map((candidate) => candidate.sourceRow))
      const partitionBySourceRow = new Map(
        partitionCandidates.map((candidate) => [candidate.sourceRow, candidate.partition])
      )

      // Why (§4.3c): a family we cannot name is one we cannot exclude from the clear, and clearing a
      // family we cannot protect is the P0. Refuse before the jar is touched.
      if (nativePlan.hasUnrepresentableSkip) {
        closeStagingDb()
        discardStagingFile()
        return {
          ok: false,
          reason:
            'Could not import: a cookie with an unreadable site partition has no registrable domain, so its existing session cannot be protected.'
        }
      }

      const needsSourceKey = sourceRows.some((sourceRow) => {
        const encRaw = sourceRow.encrypted_value
        if (!(encRaw instanceof Uint8Array) || encRaw.length === 0) {
          return false
        }
        const domain = sourceRow.host_key as string
        const name = sourceRow.name as string
        return !(isGoogleSourceBoundCookie(name, domain) || isNonTransplantableCookieDomain(domain))
      })
      const sourceKey = needsSourceKey
        ? getEncryptionKey(browser.keychainService!, browser.keychainAccount!, browser)
        : null
      if (needsSourceKey && !sourceKey) {
        closeStagingDb()
        // Why: key denial happens after staging, so clean up the target DB copy or retries pile up.
        discardStagingFile()
        return {
          ok: false,
          reason: `Could not access ${browser.label} encryption key. The OS may have denied access.`
        }
      }

      let imported = 0
      let skipped = 0
      let decryptFailed = 0
      let appBoundFailed = 0
      let keyringUnavailableFailed = 0
      let integritySkipped = 0
      let nonTransplantableSkipped = 0
      const partitionSkipped = nativePlan.skips.length
      let memoryLoaded = 0
      let memoryFailed = 0
      const domainSet = new Set<string>()

      type DecryptedCookie = Omit<ImportedCookieFields, 'url'> & {
        decryptedValue: Buffer
        sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
        partition: SourcePartitionRead
      }

      const decryptedCookies: DecryptedCookie[] = []
      // Why: the staging insert needs the RAW source row, so each scanned candidate carries it.
      // A plan record holding only the derived fields compiles fine and then cannot stage.
      const scanned: { entry: DecryptedCookie; sourceRow: Record<string, unknown> }[] = []
      const sourceDomainValidity = new Map<string, boolean>()

      // Why: staging only backs the cold-restart replay, so any failure writing it disables that
      // fallback instead of aborting an import whose in-memory half still works.
      let insertStmt: ReturnType<InstanceType<typeof DatabaseSync>['prepare']> | null = null
      const disableStaging = (reason: string): void => {
        diag(`  staging disabled, restart fallback unavailable: ${reason}`)
        stagingAvailable = false
        insertStmt = null
        closeStagingDb()
        discardStagingFile()
      }

      if (stagingDb && colList && placeholders) {
        try {
          insertStmt = stagingDb.prepare(
            `INSERT OR REPLACE INTO cookies (${colList}) VALUES (${placeholders})`
          )
          stagingDb.exec('BEGIN TRANSACTION')
        } catch (err) {
          disableStaging(String(err))
        }
      } else if (stagingAvailable) {
        disableStaging('staged database exposed no cookies columns')
      }

      // Why: keep the existing conservative fallback boundary for family-level omissions. Expanding
      // partial-import restart behavior is separate from narrowing what a staged replay may replace.
      if (nativePlan.skippedFamilies.size > 0) {
        disableStaging(
          `${nativePlan.skippedFamilies.size} preserved cookie families cannot be represented in a staged image`
        )
      }

      for (const sourceRow of sourceRows) {
        const domain = sourceRow.host_key as string
        const name = sourceRow.name as string

        if (isGoogleSourceBoundCookie(name, domain)) {
          integritySkipped++
          continue
        }

        // Why: transplanting these replaces a working sign-in with a session the site rejects.
        if (isNonTransplantableCookieDomain(domain)) {
          nonTransplantableSkipped++
          continue
        }

        const encRaw = sourceRow.encrypted_value
        // Why: node:sqlite returns BLOBs as Uint8Array; treat any other type as missing, not an empty buffer that would silently blank the cookie value.
        const encBuf = encRaw instanceof Uint8Array ? Buffer.from(encRaw) : null
        const plainRaw = sourceRow.value

        let decryptedValue: Buffer
        if (encBuf && encBuf.length > 0) {
          const version = cookieEncryptionVersion(encBuf)
          const appBoundIneligible = version === 'v20'
          const keyringIneligible =
            version === 'v11' &&
            sourceKey?.mode === 'aes-128-cbc' &&
            sourceKey.keyringUnavailable === true
          const raw =
            sourceKey && !appBoundIneligible && !keyringIneligible
              ? decryptCookieValueRaw(encBuf, sourceKey)
              : null
          if (!raw) {
            // Why: once decrypt returns null every failure looks identical, so attribute the cause
            // here while the version prefix is still in hand. Without this an undecryptable profile
            // is indistinguishable from an empty one and reports success.
            decryptFailed++
            if (appBoundIneligible) {
              appBoundFailed++
            } else if (keyringIneligible) {
              keyringUnavailableFailed++
            }
            skipped++
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

        let validDomain = sourceDomainValidity.get(domain)
        if (validDomain === undefined) {
          validDomain = normalizeCookieImportDomain(domain) !== null
          sourceDomainValidity.set(domain, validDomain)
        }
        if (!validDomain) {
          skipped++
          continue
        }

        // Decryption failures are already counted above. Every other row suppressed by the
        // pre-decryption family plan is counted once here, keeping partitionSkipped a breakdown.
        if (!plannedSourceRows.has(sourceRow)) {
          skipped++
          continue
        }

        const path = sourceRow.path as string
        const secure = sourceRow.is_secure === 1n
        const httpOnly = sourceRow.is_httponly === 1n
        const sameSite = chromiumSameSite(Number(sourceRow.samesite ?? 0))
        const expiresUtc = chromiumTimestampToUnix(sourceRow.expires_utc as bigint)
        const partition = partitionBySourceRow.get(sourceRow)!
        // Why: cookie values are raw bytes, not UTF-8; latin1 preserves 0x00–0xFF without lossy replacement.
        const value = decryptedValue.toString('latin1')

        // Why (STA-4300 I1): SCAN only. Nothing is emitted here — not decryptedCookies, not
        // domainSet, not a staging row, not the imported count. bf6dc6fcba pushed the cookie and
        // THEN applied the unreadable guard, so an unreadable row discovered late could not retract
        // a sibling already emitted, and the jar-wide clear then removed more than was written back.
        scanned.push({
          entry: {
            decryptedValue,
            value,
            domain,
            name,
            path,
            secure,
            httpOnly,
            sameSite,
            expirationDate: expiresUtc > 0 ? expiresUtc : undefined,
            partition
          },
          sourceRow
        })
      }

      for (const { entry } of scanned) {
        domainSet.add(entry.domain.startsWith('.') ? entry.domain.slice(1) : entry.domain)
      }
      // Why (STA-4797): the import may only destroy what it is replacing. Naming the scope from the
      // plan — the same rows the writes come from — is what keeps the removal set from drifting past
      // the write set, and it is derived here rather than at the clear because the staged image below
      // has to be cleared to the identical scope.
      const importScope = importedDomainScope([...domainSet])

      // Why (STA-4797): the staged image must carry the same imported-domain scope as the live clear.
      // Cold-start replay uses it to replace only those rows and preserve newer unrelated sessions.
      if (stagingDb && insertStmt) {
        try {
          prepareStagedCookiesForImport(stagingDb, importScope)
        } catch (err) {
          disableStaging(String(err))
        }
      }

      // EMIT: everything downstream derives from the plan, so there is no second place a row can
      // leak in.
      for (const { entry, sourceRow } of scanned) {
        decryptedCookies.push(entry)
        if (insertStmt && targetColumnInfo) {
          try {
            const params = buildChromiumCookieInsertParams(
              targetColumnInfo,
              sourceRow,
              entry.decryptedValue
            )
            insertStmt.run(...params)
          } catch (err) {
            disableStaging(String(err))
          }
        }
        // Why: counts importable cookies, not staged rows — the summary must stay truthful when
        // the optional staging DB is unavailable.
        imported++
      }
      diag(
        `  skipped ${integritySkipped} Google integrity cookies (SIDCC/STRP/AEC) and ${nonTransplantableSkipped} non-transplantable-domain cookies`
      )
      const googleCookiesSkipped = integritySkipped + nonTransplantableSkipped

      const undecryptableWarning = buildUndecryptableWarning({
        decryptFailed,
        appBoundFailed,
        keyringUnavailableFailed
      })

      // Why: an older remote client ignores the new counter and would present this loss as success.
      // Placed before the early return and before any jar mutation, so a client that cannot render
      // the skip fails the import outright rather than reporting a partial import as complete.
      if (partitionSkipped > 0 && options.canReportPartitionSkippedCookies === false) {
        closeStagingDb()
        discardStagingFile()
        return {
          ok: false,
          reason:
            'This Orca client cannot report cookies skipped for an unreadable site partition. Update Orca on this device and try again.'
        }
      }

      if (decryptedCookies.length === 0) {
        const zeroPathWarning = undecryptableWarning
        closeStagingDb()
        discardStagingFile()
        return {
          ok: true,
          profileId: '',
          summary: {
            totalCookies: sourceRows.length,
            importedCookies: 0,
            skippedCookies: skipped + integritySkipped + nonTransplantableSkipped,
            ...(googleCookiesSkipped > 0 ? { googleCookiesSkipped } : {}),
            // Why: partition skips are a breakdown of skippedCookies, never an addition to it, so
            // totalCookies === importedCookies + skippedCookies keeps holding on this path too.
            ...(partitionSkipped > 0 ? { partitionSkippedCookies: partitionSkipped } : {}),
            domains: [],
            // Why: a profile whose rows cannot be decrypted returns here, and without this it is
            // reported as a successful empty import.
            ...(zeroPathWarning ? { warning: zeroPathWarning } : {})
          }
        }
      }

      if (stagingDb) {
        try {
          stagingDb.exec('COMMIT')
          closeStagingDb()
          diag(`  SQLite staging complete: ${imported} cookies, ${domainSet.size} domains`)
        } catch (err) {
          disableStaging(String(err))
        }
      } else {
        diag(`  staging skipped: ${imported} cookies will load in-memory only`)
      }

      // Why: clear stale cookies for the domains being imported first; mixing them with the imported
      // set makes sites reject the session. Non-transplantable families are exempt — nothing was
      // imported for them, and their live session is the only one that works.
      // Why (STA-4797): every other site in the partition is exempt too. The rationale above reaches
      // only as far as the domains this import writes; beyond them a clear has nothing to reconcile
      // and only signs the user out of sessions the import was never about.
      // Why (STA-4300): one store spans the clear and the writes, so both halves of the import speak
      // the same CDP identities — cookies.set() cannot express the partition either one reads.
      const cookieClearStore = openCookieClearStore(targetSession)
      try {
        // Why (STA-4601): the outer lock spans the clear and the writes that repopulate the jar, so a
        // second import cannot clear between them and write on top of a newer import's jar.
        await removeTransplantableCookies(
          {
            cookies: cookieClearStore,
            snapshotClearIdentities: (cookies) => cookieClearStore.snapshotClearIdentities(cookies),
            restoreClearIdentities: (identities) =>
              cookieClearStore.restoreClearIdentities(identities)
          },
          // Why (STA-4300): the families this import declined to write must not be removed either.
          // Passing them here keeps their coordinates out of the removal plan AND out of the CDP
          // snapshot taken from it, so they are never submitted to any mutation.
          nativePlan.skippedFamilies,
          importScope
        )
        diag(
          `  cleared existing cookies for ${domainSet.size} imported domains before loading ${decryptedCookies.length} imported cookies`
        )

        const writable: SourceCookieToWrite[] = []
        for (const cookie of decryptedCookies) {
          const url = deriveUrl(cookie.domain, cookie.secure)
          if (!url) {
            memoryFailed++
            continue
          }
          writable.push({ ...cookie, url })
        }
        // Why: a rejected cookie here falls back to the staged cold-start replay rather than
        // unwinding the import, so one failure must not stop the rest from loading.
        const phase = await writeImportedCookies(cookieClearStore, writable, {
          stopOnFailure: false,
          log: diag
        })
        memoryLoaded = phase.importedCount
        memoryFailed += phase.writeRejected
      } finally {
        cookieClearStore.dispose()
      }

      diag(
        `  memory load: ${memoryLoaded} OK, ${memoryFailed} failed, ${partitionSkipped} partition-unreadable`
      )

      let warning: BrowserCookieImportSummary['warning']
      if (memoryFailed > 0 && stagingAvailable) {
        // Why: keep the staging DB so the failed cookies load from SQLite on next cold start, where CookieMonster skips validation.
        browserSessionRegistry.setPendingCookieImport(targetPartition, stagingCookiesPath)
        diag(`  staged at ${stagingCookiesPath} for ${memoryFailed} cookies that need restart`)
      } else if (memoryFailed > 0) {
        // Why: never register a path that was never written or can never be replayed — cold start
        // would replay a missing or partial DB over the live partition.
        browserSessionRegistry.clearPendingCookieImport(targetPartition)
        discardStagingFile()
        diag(`  ${memoryFailed} cookies need a restart but staging is unavailable — skipped`)
        // Why: the jar was already cleared, so silence here would report a lossy import as a clean success.
        warning = {
          code: 'restart-fallback-unavailable',
          loadedCookies: memoryLoaded,
          failedCookies: memoryFailed
        }
      } else {
        // Why: this import already rewrote the live session, so an older staged DB must not replay over it.
        browserSessionRegistry.clearPendingCookieImport(targetPartition)
        discardStagingFile()
        diag(`  all cookies loaded in-memory — no restart needed`)
      }

      // Why: the session keeps the UA the registry set at startup (clean or native).
      // Imports must not impersonate the source browser — the synthesized UA read a
      // fork's marketing version as a Chromium version (STA-3514), and Google binds
      // sessions to the re-import, not the UA (#12884), so it bought nothing.
      // Google-bound integrity cookies are already excluded by
      // isGoogleSourceBoundCookie, which is what actually prevents CookieMismatch.

      // Why: a partial import still drops every undecryptable row, so silence here would report it
      // as an unqualified success. The restart-fallback warning describes a lossier outcome and
      // keeps precedence.
      if (!warning && undecryptableWarning) {
        warning = undecryptableWarning
      }

      const summary: BrowserCookieImportSummary = {
        totalCookies: sourceRows.length,
        importedCookies: imported,
        skippedCookies: skipped + integritySkipped + nonTransplantableSkipped,
        ...(googleCookiesSkipped > 0 ? { googleCookiesSkipped } : {}),
        ...(partitionSkipped > 0 ? { partitionSkippedCookies: partitionSkipped } : {}),
        domains: [...domainSet].sort(),
        ...(warning ? { warning } : {})
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
      // Why: drop the staging DB so a stale staged import isn't applied on the next cold start.
      try {
        unlinkSync(stagingCookiesPath)
      } catch {
        /* may not exist yet */
      }
      diag(`  SQLite import failed: ${String(err)}`)
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
        diag(`  Chromium snapshot cleanup failed: ${String(err)}`)
      }
    }
  })
}
