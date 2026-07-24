/* eslint-disable max-lines -- Why: single source of truth for browser session profiles, partition allowlisting, cookie staging, and per-partition policies; splitting scatters the security boundary. */
import { app, session } from 'electron'
import type { Session } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { ORCA_BROWSER_PARTITION } from '../../shared/constants'
import {
  DEFAULT_LOCAL_ORCA_PROFILE_ID,
  getOrcaProfileBrowserDefaultPartition,
  getOrcaProfileBrowserPartitionSegment,
  getOrcaProfileBrowserSessionPartition
} from '../../shared/orca-profiles'
import type { BrowserSessionProfile, BrowserSessionProfileScope } from '../../shared/types'
import { browserManager } from './browser-manager'
import { hasSystemMediaAccess, requestSystemMediaAccess } from './browser-media-access'
import { cleanElectronUserAgent, setupClientHintsOverride } from './browser-session-ua'
import { resolveChromiumCookiesPath } from './chromium-cookie-path'
import { isAutoGrantedBrowserSessionPermission } from './browser-session-permission-policy'
import {
  allowsBrowserWebAuthnPermission,
  clearBrowserWebAuthnAccessHandlers,
  installBrowserWebAuthnAccessHandlers
} from './browser-webauthn-access'

type BrowserSessionMeta = {
  defaultSource: BrowserSessionProfile['source']
  userAgent: string | null
  userAgentByPartition: Record<string, string>
  pendingCookieDbPath: string | null
  pendingCookieImports: Record<string, string>
  profiles: BrowserSessionProfile[]
}

export type BrowserSessionRegistryProfileOptions = {
  orcaProfileId: string
  profileDirectory: string
}

const BROWSER_SESSION_META_FILE_NAME = 'browser-session-meta.json'
const LEGACY_BROWSER_SESSION_PARTITION_RE =
  /^persist:orca-browser-session-[\da-f-]{8}-[\da-f-]{4}-[\da-f-]{4}-[\da-f-]{4}-[\da-f-]{12}$/

// Why: source of truth for valid partitions; will-attach-webview consults it so a compromised renderer can't smuggle in an arbitrary partition.

class BrowserSessionRegistry {
  private readonly profiles = new Map<string, BrowserSessionProfile>()
  private activeOrcaProfileId = DEFAULT_LOCAL_ORCA_PROFILE_ID
  private metadataPathOverride: string | null = null
  private defaultPartition = ORCA_BROWSER_PARTITION

  constructor() {
    this.resetDefaultProfile()
  }

  configureForOrcaProfile(options: BrowserSessionRegistryProfileOptions): void {
    this.activeOrcaProfileId = options.orcaProfileId
    this.metadataPathOverride = join(options.profileDirectory, BROWSER_SESSION_META_FILE_NAME)
    this.defaultPartition = getOrcaProfileBrowserDefaultPartition(options.orcaProfileId)
    this.profiles.clear()
    this.resetDefaultProfile()
  }

  private resetDefaultProfile(): void {
    const persisted = this.loadPersistedSource()
    this.profiles.set('default', {
      id: 'default',
      scope: 'default',
      partition: this.defaultPartition,
      label: 'Default',
      source: persisted
    })
  }

  // Why: source metadata must persist across restarts (for the Settings import status) since the registry is in-memory only.
  private get metadataPath(): string {
    return (
      this.metadataPathOverride ?? join(app.getPath('userData'), BROWSER_SESSION_META_FILE_NAME)
    )
  }

  private loadPersistedSource(): BrowserSessionProfile['source'] {
    return this.loadPersistedMeta().defaultSource
  }

  private static partitionCookiesPath(partition: string): string {
    const partitionName = partition.replace('persist:', '')
    const partitionDir = join(app.getPath('userData'), 'Partitions', partitionName)
    // Why: replay must overwrite the same (modern or legacy) DB the importing partition already uses.
    return resolveChromiumCookiesPath(partitionDir) ?? join(partitionDir, 'Cookies')
  }

  // Why: write-temp-then-rename is atomic, so a crash mid-write can't corrupt the live file.
  private persistMeta(updates: Partial<BrowserSessionMeta>): void {
    try {
      const existing = this.loadPersistedMeta()
      const tmpPath = `${this.metadataPath}.tmp`
      mkdirSync(dirname(this.metadataPath), { recursive: true })
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

  // Why: non-default profiles are in-memory only; without this they vanish on restart.
  private persistProfiles(): void {
    const nonDefault = [...this.profiles.values()].filter((p) => p.id !== 'default')
    this.persistMeta({ profiles: nonDefault })
  }

  private loadPersistedMeta(): BrowserSessionMeta {
    try {
      const raw = readFileSync(this.metadataPath, 'utf-8')
      const data = JSON.parse(raw)
      const legacyUserAgent = typeof data?.userAgent === 'string' ? data.userAgent : null
      const userAgentByPartition: Record<string, string> =
        data && typeof data.userAgentByPartition === 'object' && data.userAgentByPartition
          ? { ...data.userAgentByPartition }
          : {}
      if (legacyUserAgent && !userAgentByPartition[this.defaultPartition]) {
        userAgentByPartition[this.defaultPartition] = legacyUserAgent
      }

      const legacyPendingCookieDbPath =
        typeof data?.pendingCookieDbPath === 'string' ? data.pendingCookieDbPath : null
      const pendingCookieImports: Record<string, string> =
        data && typeof data.pendingCookieImports === 'object' && data.pendingCookieImports
          ? { ...data.pendingCookieImports }
          : {}
      if (legacyPendingCookieDbPath && !pendingCookieImports[this.defaultPartition]) {
        pendingCookieImports[this.defaultPartition] = legacyPendingCookieDbPath
      }
      return {
        defaultSource: data?.defaultSource ?? null,
        userAgent: legacyUserAgent,
        userAgentByPartition,
        pendingCookieDbPath: legacyPendingCookieDbPath,
        pendingCookieImports,
        profiles: Array.isArray(data?.profiles) ? data.profiles : []
      }
    } catch {
      return {
        defaultSource: null,
        userAgent: null,
        userAgentByPartition: {},
        pendingCookieDbPath: null,
        pendingCookieImports: {},
        profiles: []
      }
    }
  }

  // Why: run before any webview loads, and set the UA before the first request or Electron's default UA invalidates imported cookies.
  // Why re-read defaultSource: the constructor may run before app.isReady() (userData path unavailable), so loadPersistedSource() returned null.
  initializeBrowserSessionsFromPersistedState(): void {
    const meta = this.loadPersistedMeta()
    if (meta.defaultSource) {
      const current = this.profiles.get('default')
      if (current && current.source === null) {
        this.profiles.set('default', { ...current, source: meta.defaultSource })
      }
    }
    if (meta.profiles.length > 0) {
      this.hydrateFromPersisted(meta.profiles)
    }

    // Why: nothing else installs policies on the default partition (hydrate skips it), so without this its guest permissions would be denied.
    this.setupSessionPolicies(this.defaultPartition)

    const partitions = new Set([
      this.defaultPartition,
      ...this.listProfiles().map((p) => p.partition)
    ])
    for (const partition of partitions) {
      try {
        const sess = session.fromPartition(partition)
        const persistedUa = meta.userAgentByPartition[partition]
        if (persistedUa) {
          sess.setUserAgent(persistedUa)
          setupClientHintsOverride(sess, persistedUa)
          continue
        }

        // Why: the default Electron UA leaks "Electron/X.X.X" + app name, which trips Cloudflare Turnstile.
        const cleanUA = cleanElectronUserAgent(sess.getUserAgent())
        sess.setUserAgent(cleanUA)
        setupClientHintsOverride(sess, cleanUA)
      } catch {
        /* session not available yet (e.g. unit tests or pre-ready) */
      }
    }
  }

  // Why: must run before any session.fromPartition() so CookieMonster reads the staged cookies instead of overwriting them from its in-memory DB.
  applyPendingCookieImport(): void {
    try {
      const meta = this.loadPersistedMeta()
      const pendingEntries = Object.entries(meta.pendingCookieImports)
      if (pendingEntries.length === 0) {
        return
      }
      // Why: replay writes to partition-derived paths, so corrupted metadata must pass the same validation as the webview allowlist.
      const knownPartitions = new Set([this.defaultPartition])
      for (const profile of meta.profiles) {
        if (this.isValidPersistedProfile(profile)) {
          knownPartitions.add(profile.partition)
        }
      }
      const remainingEntries = { ...meta.pendingCookieImports }

      for (const [partition, stagedPath] of pendingEntries) {
        if (!knownPartitions.has(partition)) {
          delete remainingEntries[partition]
          continue
        }
        if (!existsSync(stagedPath)) {
          delete remainingEntries[partition]
          continue
        }

        const liveCookiesPath = BrowserSessionRegistry.partitionCookiesPath(partition)
        try {
          mkdirSync(join(liveCookiesPath, '..'), { recursive: true })
          copyFileSync(stagedPath, liveCookiesPath)
          // Why: stale WAL/SHM sidecars would corrupt CookieMonster's read of the freshly swapped DB.
          let sidecarCopyFailed = false
          for (const suffix of ['-wal', '-shm']) {
            try {
              unlinkSync(liveCookiesPath + suffix)
            } catch {
              /* may not exist */
            }
            const stagingSidecar = stagedPath + suffix
            if (!existsSync(stagingSidecar)) {
              continue
            }
            try {
              copyFileSync(stagingSidecar, liveCookiesPath + suffix)
            } catch {
              sidecarCopyFailed = true
            }
          }
          if (sidecarCopyFailed) {
            // Why: sidecar copy failed → inconsistent replay; keep this entry for retry.
            continue
          }
          for (const ext of ['', '-wal', '-shm']) {
            try {
              unlinkSync(`${stagedPath}${ext}`)
            } catch {
              /* best-effort */
            }
          }
          delete remainingEntries[partition]
        } catch {
          // Why: keep this entry for retry — one partition's failed replay shouldn't drop unrelated entries.
        }
      }
      this.persistMeta({
        pendingCookieImports: remainingEntries,
        pendingCookieDbPath: remainingEntries[this.defaultPartition] ?? null
      })
    } catch {
      // best-effort — if this fails, CookieMonster loads the old DB
    }
  }

  setPendingCookieImport(partition: string, stagingDbPath: string): void {
    const meta = this.loadPersistedMeta()
    const pendingCookieImports = { ...meta.pendingCookieImports, [partition]: stagingDbPath }
    this.persistMeta({
      pendingCookieImports,
      pendingCookieDbPath: pendingCookieImports[this.defaultPartition] ?? null
    })
  }

  persistUserAgent(partition: string, userAgent: string | null): void {
    const meta = this.loadPersistedMeta()
    const userAgentByPartition = { ...meta.userAgentByPartition }
    if (userAgent) {
      userAgentByPartition[partition] = userAgent
    } else {
      delete userAgentByPartition[partition]
    }
    this.persistMeta({
      userAgentByPartition,
      userAgent: userAgentByPartition[this.defaultPartition] ?? null
    })
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
    if (partition === this.defaultPartition) {
      return true
    }
    return [...this.profiles.values()].some((p) => p.partition === partition)
  }

  resolvePartition(profileId: string | null | undefined): string {
    if (!profileId) {
      return this.defaultPartition
    }
    return this.profiles.get(profileId)?.partition ?? this.defaultPartition
  }

  resolveKnownPartition(profileId: string | null | undefined): string | null {
    if (!profileId) {
      // Why: use the active Orca profile's default partition, not the legacy constant, or profiles resolve local-default's cookie jar.
      return this.defaultPartition
    }
    return this.profiles.get(profileId)?.partition ?? null
  }

  createProfile(scope: BrowserSessionProfileScope, label: string): BrowserSessionProfile | null {
    // Why: block scope:'default' here — only the constructor makes the default profile; a second one sharing the partition breaks delete.
    if (scope === 'default') {
      return null
    }
    const id = randomUUID()
    // Why: deterministic partition-from-id lets main rebuild the allowlist on restart without a separate partition→profile map.
    const partition = getOrcaProfileBrowserSessionPartition(this.activeOrcaProfileId, id)
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
    const meta = this.loadPersistedMeta()
    const pendingCookieImports = { ...meta.pendingCookieImports }
    delete pendingCookieImports[profile.partition]
    const userAgentByPartition = { ...meta.userAgentByPartition }
    delete userAgentByPartition[profile.partition]
    this.persistMeta({
      pendingCookieImports,
      pendingCookieDbPath: pendingCookieImports[this.defaultPartition] ?? null,
      userAgentByPartition,
      userAgent: userAgentByPartition[this.defaultPartition] ?? null
    })

    // Why: clear the partition's storage so deleting a profile doesn't leave orphaned cookies/cache behind.
    try {
      const sess = session.fromPartition(profile.partition)
      this.clearSessionPolicies(profile.partition, sess)
      await sess.clearStorageData()
      await sess.clearCache()
    } catch {
      // Why: cleanup is best-effort — the profile is already out of the registry, so will-attach-webview blocks it regardless.
    }
    return true
  }

  // Why: lets users undo a cookie import without deleting the default profile itself.
  async clearDefaultSessionCookies(): Promise<boolean> {
    try {
      // Why: persist metadata before clearing storage so a mid-clear quit doesn't leave a stale "imported from X" badge.
      const defaultProfile = this.profiles.get('default')
      if (defaultProfile) {
        this.profiles.set('default', { ...defaultProfile, source: null })
      }
      const meta = this.loadPersistedMeta()
      const pendingCookieImports = { ...meta.pendingCookieImports }
      delete pendingCookieImports[this.defaultPartition]
      const userAgentByPartition = { ...meta.userAgentByPartition }
      delete userAgentByPartition[this.defaultPartition]
      this.persistMeta({
        defaultSource: null,
        userAgent: null,
        userAgentByPartition,
        pendingCookieDbPath: null,
        pendingCookieImports
      })

      const sess = session.fromPartition(this.defaultPartition)
      await sess.clearStorageData({ storages: ['cookies'] })
      return true
    } catch {
      return false
    }
  }

  // Why: validate on-disk profile shape so a tampered JSON file can't inject an arbitrary partition into the will-attach-webview allowlist.
  private isValidPersistedProfile(profile: unknown): profile is BrowserSessionProfile {
    if (!profile || typeof profile !== 'object') {
      return false
    }
    const candidate = profile as Partial<BrowserSessionProfile>
    return (
      candidate.id !== 'default' &&
      candidate.scope !== 'default' &&
      typeof candidate.id === 'string' &&
      typeof candidate.partition === 'string' &&
      typeof candidate.label === 'string' &&
      this.isProfileOwnedSessionPartition(candidate.partition)
    )
  }

  private isProfileOwnedSessionPartition(partition: string): boolean {
    if (
      this.activeOrcaProfileId === DEFAULT_LOCAL_ORCA_PROFILE_ID &&
      LEGACY_BROWSER_SESSION_PARTITION_RE.test(partition)
    ) {
      return true
    }

    const segment = getOrcaProfileBrowserPartitionSegment(this.activeOrcaProfileId)
    const prefix = `persist:orca-profile-${segment}-browser-session-`
    if (!partition.startsWith(prefix)) {
      return false
    }
    const profileId = partition.slice(prefix.length)
    return /^[\da-f-]{8}-[\da-f-]{4}-[\da-f-]{4}-[\da-f-]{4}-[\da-f-]{12}$/.test(profileId)
  }

  hydrateFromPersisted(profiles: BrowserSessionProfile[]): void {
    for (const profile of profiles) {
      if (!this.isValidPersistedProfile(profile)) {
        continue
      }
      this.profiles.set(profile.id, profile)
      if (profile.partition !== this.defaultPartition) {
        this.setupSessionPolicies(profile.partition)
      }
    }
  }

  // Why: one shared installer keeps every partition's deny-by-default permission/download policies from drifting apart.
  private readonly configuredPartitions = new Set<string>()
  private readonly handleWillDownload = (
    _event: Electron.Event,
    item: Electron.DownloadItem,
    webContents: Electron.WebContents
  ): void => {
    browserManager.handleGuestWillDownload({ guestWebContentsId: webContents.id, item })
  }

  private setupSessionPolicies(partition: string): void {
    if (this.configuredPartitions.has(partition)) {
      return
    }

    const sess = session.fromPartition(partition)
    browserManager.installCertificateRequestGuard(sess)
    if (typeof sess.getUserAgent === 'function') {
      const cleanUA = cleanElectronUserAgent(sess.getUserAgent())
      sess.setUserAgent(cleanUA)
      setupClientHintsOverride(sess, cleanUA)
    }
    sess.setPermissionRequestHandler((webContents, permission, callback, details) => {
      // Why: defer media to macOS TCC; denying at the session layer throws NotAllowedError even after the user granted Camera/Mic to the OS.
      if (permission === 'media') {
        void requestSystemMediaAccess(
          details as Electron.MediaAccessPermissionRequest | undefined
        ).then(
          (granted) => {
            if (!granted) {
              browserManager.notifyPermissionDenied({
                guestWebContentsId: webContents.id,
                permission,
                rawUrl: webContents.getURL()
              })
            }
            callback(granted)
          },
          (error: unknown) => {
            console.error('[permissions] Browser media access failed:', error)
            browserManager.notifyPermissionDenied({
              guestWebContentsId: webContents.id,
              permission,
              rawUrl: webContents.getURL()
            })
            callback(false)
          }
        )
        return
      }
      const allowed = isAutoGrantedBrowserSessionPermission(permission)
      if (!allowed) {
        browserManager.notifyPermissionDenied({
          guestWebContentsId: webContents.id,
          permission,
          rawUrl: webContents.getURL()
        })
      }
      callback(allowed)
    })
    sess.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
      if (permission === 'media') {
        return hasSystemMediaAccess(details?.mediaType)
      }
      if (allowsBrowserWebAuthnPermission(permission, details)) {
        return true
      }
      return isAutoGrantedBrowserSessionPermission(permission)
    })
    installBrowserWebAuthnAccessHandlers(sess)
    sess.setDisplayMediaRequestHandler((_request, callback) => {
      callback({ video: undefined, audio: undefined })
    })
    sess.removeListener('will-download', this.handleWillDownload)
    sess.on('will-download', this.handleWillDownload)
    this.configuredPartitions.add(partition)
  }

  private clearSessionPolicies(partition: string, sess: Session): void {
    // Why: the Electron Session survives partition deletion; clear callbacks/listeners so removed profiles don't retain closures.
    this.configuredPartitions.delete(partition)
    browserManager.removeCertificateRequestGuard(sess)
    sess.removeListener('will-download', this.handleWillDownload)
    clearBrowserWebAuthnAccessHandlers(sess)
    sess.setPermissionRequestHandler(null)
    sess.setPermissionCheckHandler(null)
    sess.setDisplayMediaRequestHandler(null)
  }
}

export const browserSessionRegistry = new BrowserSessionRegistry()
