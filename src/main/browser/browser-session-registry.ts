import { app, type Session, session } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { ORCA_BROWSER_PARTITION } from '../../shared/constants'
import type { BrowserSessionProfile, BrowserSessionProfileScope } from '../../shared/types'
import { browserManager } from './browser-manager'

type BrowserSessionMeta = {
  defaultSource: BrowserSessionProfile['source']
  userAgent: string | null
  pendingCookieDbPath: string | null
  profiles: BrowserSessionProfile[]
}

// Why: the registry is the single source of truth for which Electron partitions
// are valid. will-attach-webview consults it to decide whether a guest's
// requested partition is allowed. This prevents a compromised renderer from
// smuggling an arbitrary partition string into a guest surface.

class BrowserSessionRegistry {
  private readonly profiles = new Map<string, BrowserSessionProfile>()

  constructor() {
    const persisted = this.loadPersistedSource()
    this.profiles.set('default', {
      id: 'default',
      scope: 'default',
      partition: ORCA_BROWSER_PARTITION,
      label: 'Default',
      source: persisted
    })
  }

  // Why: the default profile's source metadata (what browser was imported,
  // when) must survive app restarts so the Settings UI can show the import
  // status. Cookies themselves persist in the Electron partition's SQLite DB,
  // but the registry is in-memory only.
  private get metadataPath(): string {
    return join(app.getPath('userData'), 'browser-session-meta.json')
  }

  private loadPersistedSource(): BrowserSessionProfile['source'] {
    return this.loadPersistedMeta().defaultSource
  }

  // Why: write-to-temp-then-rename is atomic on all supported platforms.
  // A crash mid-write would only lose the temp file, not corrupt the live one.
  private persistMeta(updates: Partial<BrowserSessionMeta>): void {
    try {
      const existing = this.loadPersistedMeta()
      const tmpPath = `${this.metadataPath}.tmp`
      writeFileSync(tmpPath, JSON.stringify({ ...existing, ...updates }))
      renameSync(tmpPath, this.metadataPath)
    } catch {
      // best-effort
    }
  }

  private persistSource(source: BrowserSessionProfile['source'], userAgent?: string | null): void {
    this.persistMeta({
      defaultSource: source,
      ...(userAgent !== undefined ? { userAgent } : {})
    })
  }

  // Why: non-default profiles are in-memory only unless explicitly persisted.
  // Without this, created profiles vanish on app restart.
  private persistProfiles(): void {
    const nonDefault = [...this.profiles.values()].filter((p) => p.id !== 'default')
    this.persistMeta({ profiles: nonDefault })
  }

  private loadPersistedMeta(): BrowserSessionMeta {
    try {
      const raw = readFileSync(this.metadataPath, 'utf-8')
      const data = JSON.parse(raw)
      return {
        defaultSource: data?.defaultSource ?? null,
        userAgent: data?.userAgent ?? null,
        pendingCookieDbPath: data?.pendingCookieDbPath ?? null,
        profiles: Array.isArray(data?.profiles) ? data.profiles : []
      }
    } catch {
      return { defaultSource: null, userAgent: null, pendingCookieDbPath: null, profiles: [] }
    }
  }

  // Why: the User-Agent must be set on the session BEFORE any webview loads,
  // otherwise the first request uses Electron's default UA and the server may
  // invalidate the imported session cookies.
  //
  // Why this also refreshes defaultSource: the singleton constructor runs at
  // module-import time, which may be before app.isReady(). app.getPath('userData')
  // is not guaranteed before ready, so the constructor's loadPersistedSource()
  // silently returns null. Re-reading here (called from registerCoreHandlers,
  // after app is ready) ensures the default profile's source is populated.
  restorePersistedUserAgent(): void {
    const meta = this.loadPersistedMeta()
    if (meta.userAgent) {
      const sess = session.fromPartition(ORCA_BROWSER_PARTITION)
      sess.setUserAgent(meta.userAgent)
      this.setupClientHintsOverride(sess, meta.userAgent)
    }
    if (meta.defaultSource) {
      const current = this.profiles.get('default')
      if (current && current.source === null) {
        this.profiles.set('default', { ...current, source: meta.defaultSource })
      }
    }
    if (meta.profiles.length > 0) {
      this.hydrateFromPersisted(meta.profiles)
    }
  }

  // Why: Electron's actual Chromium version (e.g. 134) differs from the source
  // browser's version (e.g. Edge 147). The sec-ch-ua Client Hints headers
  // reveal the real version, creating a mismatch that Google's anti-fraud
  // detection flags as CookieMismatch on accounts.google.com. Override Client
  // Hints on outgoing requests to match the source browser's UA.
  setupClientHintsOverride(sess: Session, ua: string): void {
    const chromeMatch = ua.match(/Chrome\/([\d.]+)/)
    if (!chromeMatch) {
      return
    }
    const fullChromeVersion = chromeMatch[1]
    const majorVersion = fullChromeVersion.split('.')[0]

    let brand = 'Google Chrome'
    let brandFullVersion = fullChromeVersion

    const edgeMatch = ua.match(/Edg\/([\d.]+)/)
    if (edgeMatch) {
      brand = 'Microsoft Edge'
      brandFullVersion = edgeMatch[1]
    }
    const brandMajor = brandFullVersion.split('.')[0]

    const secChUa = `"${brand}";v="${brandMajor}", "Chromium";v="${majorVersion}", "Not/A)Brand";v="24"`
    const secChUaFull = `"${brand}";v="${brandFullVersion}", "Chromium";v="${fullChromeVersion}", "Not/A)Brand";v="24.0.0.0"`

    sess.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
      const headers = details.requestHeaders
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase()
        if (lower === 'sec-ch-ua') {
          headers[key] = secChUa
        } else if (lower === 'sec-ch-ua-full-version-list') {
          headers[key] = secChUaFull
        }
      }
      callback({ requestHeaders: headers })
    })
  }

  // Why: the import writes cookies to a staging DB because CookieMonster holds
  // the live DB's data in memory and would overwrite our changes on its next
  // flush. This method MUST run before any session.fromPartition() call so
  // CookieMonster reads the staged cookies instead of the stale live DB.
  applyPendingCookieImport(): void {
    try {
      const meta = this.loadPersistedMeta()
      if (!meta.pendingCookieDbPath) {
        return
      }
      if (!existsSync(meta.pendingCookieDbPath)) {
        this.persistMeta({ pendingCookieDbPath: null })
        return
      }

      const partitionName = ORCA_BROWSER_PARTITION.replace('persist:', '')
      const liveCookiesPath = join(app.getPath('userData'), 'Partitions', partitionName, 'Cookies')

      copyFileSync(meta.pendingCookieDbPath, liveCookiesPath)
      // Why: SQLite WAL mode stores uncommitted data in sidecar files.
      // Stale WAL/SHM from a previous session could corrupt CookieMonster's
      // read of the freshly swapped DB.
      for (const suffix of ['-wal', '-shm']) {
        try {
          unlinkSync(liveCookiesPath + suffix)
        } catch {
          /* may not exist */
        }
        const stagingSidecar = meta.pendingCookieDbPath + suffix
        if (existsSync(stagingSidecar)) {
          try {
            copyFileSync(stagingSidecar, liveCookiesPath + suffix)
          } catch {
            /* best-effort */
          }
        }
      }
      for (const ext of ['', '-wal', '-shm']) {
        try {
          unlinkSync(`${meta.pendingCookieDbPath}${ext}`)
        } catch {
          /* best-effort */
        }
      }
      this.persistMeta({ pendingCookieDbPath: null })
    } catch {
      // best-effort — if this fails, CookieMonster loads the old DB
    }
  }

  setPendingCookieImport(stagingDbPath: string): void {
    this.persistMeta({ pendingCookieDbPath: stagingDbPath })
  }

  persistUserAgent(userAgent: string | null): void {
    const defaultProfile = this.profiles.get('default')
    this.persistSource(defaultProfile?.source ?? null, userAgent)
  }

  getDefaultProfile(): BrowserSessionProfile {
    return this.profiles.get('default')!
  }

  getProfile(profileId: string): BrowserSessionProfile | null {
    return this.profiles.get(profileId) ?? null
  }

  listProfiles(): BrowserSessionProfile[] {
    return [...this.profiles.values()]
  }

  isAllowedPartition(partition: string): boolean {
    if (partition === ORCA_BROWSER_PARTITION) {
      return true
    }
    return [...this.profiles.values()].some((p) => p.partition === partition)
  }

  resolvePartition(profileId: string | null | undefined): string {
    if (!profileId) {
      return ORCA_BROWSER_PARTITION
    }
    return this.profiles.get(profileId)?.partition ?? ORCA_BROWSER_PARTITION
  }

  createProfile(scope: BrowserSessionProfileScope, label: string): BrowserSessionProfile | null {
    // Why: only the constructor may create the default profile. Allowing the
    // renderer to pass scope:'default' would create a second profile sharing
    // ORCA_BROWSER_PARTITION, causing confusion on delete (clearing storage
    // for the shared partition).
    if (scope === 'default') {
      return null
    }
    const id = randomUUID()
    // Why: partition names are deterministic from the profile id so main can
    // reconstruct the allowlist on restart from persisted profile metadata
    // without needing a separate partition→profile mapping.
    const partition = `persist:orca-browser-session-${id}`
    const profile: BrowserSessionProfile = {
      id,
      scope,
      partition,
      label,
      source: null
    }
    this.profiles.set(id, profile)
    this.setupSessionPolicies(partition)
    this.persistProfiles()
    return profile
  }

  updateProfileSource(
    profileId: string,
    source: BrowserSessionProfile['source']
  ): BrowserSessionProfile | null {
    const profile = this.profiles.get(profileId)
    if (!profile) {
      return null
    }
    const updated = { ...profile, source }
    this.profiles.set(profileId, updated)
    if (profileId === 'default') {
      this.persistSource(source)
    } else {
      this.persistProfiles()
    }
    return updated
  }

  async deleteProfile(profileId: string): Promise<boolean> {
    const profile = this.profiles.get(profileId)
    if (!profile || profile.scope === 'default') {
      return false
    }
    this.profiles.delete(profileId)
    this.persistProfiles()

    // Why: clearing the partition's storage prevents orphaned cookies/cache from
    // lingering after the user deletes an imported or isolated session profile.
    try {
      const sess = session.fromPartition(profile.partition)
      await sess.clearStorageData()
      await sess.clearCache()
    } catch {
      // Why: partition cleanup is best-effort. The profile is already removed
      // from the registry so it won't be allowed by will-attach-webview.
    }
    return true
  }

  // Why: clearing cookies from the default partition lets users undo a cookie
  // import without deleting the default profile itself.
  async clearDefaultSessionCookies(): Promise<boolean> {
    try {
      // Why: persist metadata BEFORE clearing storage so that if the app quits
      // mid-clear, the next launch won't show a stale "imported from X" badge
      // for cookies that were partially or fully removed.
      const defaultProfile = this.profiles.get('default')
      if (defaultProfile) {
        this.profiles.set('default', { ...defaultProfile, source: null })
      }
      this.persistMeta({ defaultSource: null, userAgent: null, pendingCookieDbPath: null })

      const sess = session.fromPartition(ORCA_BROWSER_PARTITION)
      await sess.clearStorageData({ storages: ['cookies'] })
      return true
    } catch {
      return false
    }
  }

  // Why: on startup, main must reconstruct the set of valid partitions from
  // persisted session profiles so restored webviews are not denied by
  // will-attach-webview before the renderer mounts them.
  // Why: profiles are deserialized from a JSON file on disk. A corrupted or
  // tampered file could inject an arbitrary partition into the allowlist that
  // will-attach-webview trusts, so we validate the expected shape before
  // registering anything.
  private static readonly PARTITION_RE = /^persist:orca-browser-session-[\da-f-]{36}$/

  hydrateFromPersisted(profiles: BrowserSessionProfile[]): void {
    for (const profile of profiles) {
      if (profile.id === 'default' || profile.scope === 'default') {
        continue
      }
      if (
        typeof profile.id !== 'string' ||
        typeof profile.partition !== 'string' ||
        typeof profile.label !== 'string' ||
        !BrowserSessionRegistry.PARTITION_RE.test(profile.partition)
      ) {
        continue
      }
      this.profiles.set(profile.id, profile)
      if (profile.partition !== ORCA_BROWSER_PARTITION) {
        this.setupSessionPolicies(profile.partition)
      }
    }
  }

  // Why: each non-default partition needs the same deny-by-default permission
  // and download policies as the shared partition. Without this, newly created
  // session partitions would silently allow permissions and downloads that the
  // shared partition correctly denies.
  private readonly configuredPartitions = new Set<string>()

  private setupSessionPolicies(partition: string): void {
    if (this.configuredPartitions.has(partition)) {
      return
    }
    this.configuredPartitions.add(partition)

    const sess = session.fromPartition(partition)
    sess.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowed = permission === 'fullscreen'
      if (!allowed) {
        browserManager.notifyPermissionDenied({
          guestWebContentsId: webContents.id,
          permission,
          rawUrl: webContents.getURL()
        })
      }
      callback(allowed)
    })
    sess.setPermissionCheckHandler((_webContents, permission) => {
      return permission === 'fullscreen'
    })
    sess.setDisplayMediaRequestHandler((_request, callback) => {
      callback({ video: undefined, audio: undefined })
    })
    sess.on('will-download', (_event, item, webContents) => {
      browserManager.handleGuestWillDownload({ guestWebContentsId: webContents.id, item })
    })
  }
}

export const browserSessionRegistry = new BrowserSessionRegistry()
