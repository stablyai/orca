import { app, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ORCA_BROWSER_PARTITION } from '../../shared/constants'
import {
  DEFAULT_LOCAL_ORCA_PROFILE_ID,
  getOrcaProfileBrowserDefaultPartition,
  getOrcaProfileBrowserSessionPartition
} from '../../shared/orca-profiles'
import type {
  BrowserSessionProfile,
  BrowserSessionProfileCreateOptions,
  BrowserSessionProfileScope
} from '../../shared/browser-workspace-types'
import {
  applyPendingBrowserCookieImports,
  clearPendingBrowserCookieImport,
  clearPendingBrowserCookieImportNonTransplantable,
  setPendingBrowserCookieImport
} from './browser-session-cookie-staging'
import { removeNonTransplantableCookies } from './browser-cookie-import-clear'
import {
  BROWSER_SESSION_META_FILE_NAME,
  loadBrowserSessionMeta,
  persistBrowserSessionMeta
} from './browser-session-meta-store'
import type { BrowserSessionMeta } from './browser-session-meta-store'
import {
  applyBrowserSessionUserAgentModes,
  clearBrowserSessionPartitionPolicies,
  installBrowserSessionPartitionPolicies
} from './browser-session-partition-policies'
import { isValidPersistedBrowserSessionProfile } from './browser-session-persisted-profile-validation'
import { clearBrowserSessionUserAgentMode } from './browser-session-user-agent-mode'

export type BrowserSessionRegistryProfileOptions = {
  orcaProfileId: string
  profileDirectory: string
}

// Why: source of truth for valid partitions; will-attach-webview consults it so a compromised renderer can't smuggle in an arbitrary partition.

class BrowserSessionRegistry {
  private readonly profiles = new Map<string, BrowserSessionProfile>()
  private activeOrcaProfileId = DEFAULT_LOCAL_ORCA_PROFILE_ID
  private metadataPathOverride: string | null = null
  private defaultPartition = ORCA_BROWSER_PARTITION
  // Why: in-memory is enough because every comparison lives inside ONE importCookiesFromBrowser
  // call — the mark is read beside the snapshot and compared before that call returns, so no
  // comparison can span a restart, and a restart that zeroes these also guarantees there is no
  // in-flight snapshot to compare against.
  private nonTransplantableClearMarks = new Map<string, number>()
  // Why: a profile-wide wipe is a strict superset of a Google clear but needs a DIFFERENT remedy —
  // drop the staged replay entirely rather than strip one family from it — so registration has to
  // be able to tell which kind of clear moved. One counter could not carry that distinction.
  private profileCookieClearMarks = new Map<string, number>()

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

  private persistMeta(updates: Partial<BrowserSessionMeta>): void {
    persistBrowserSessionMeta(() => this.metadataPath, this.defaultPartition, updates)
  }

  private persistSource(source: BrowserSessionProfile['source']): void {
    this.persistMeta({ defaultSource: source })
  }

  // Why: non-default profiles are in-memory only; without this they vanish on restart.
  private persistProfiles(): void {
    const nonDefault = [...this.profiles.values()].filter((p) => p.id !== 'default')
    this.persistMeta({ profiles: nonDefault })
  }

  private loadPersistedMeta(): BrowserSessionMeta {
    return loadBrowserSessionMeta(() => this.metadataPath, this.defaultPartition)
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
    installBrowserSessionPartitionPolicies(this.getDefaultProfile())

    applyBrowserSessionUserAgentModes(this.listProfiles())
  }

  // Why: must run before any session.fromPartition() so CookieMonster reads the staged cookies instead of overwriting them from its in-memory DB.
  applyPendingCookieImport(): void {
    applyPendingBrowserCookieImports({
      resolveMetadataPath: () => this.metadataPath,
      defaultPartition: this.defaultPartition,
      activeOrcaProfileId: this.activeOrcaProfileId
    })
  }

  setPendingCookieImport(partition: string, stagingDbPath: string): void {
    setPendingBrowserCookieImport({
      resolveMetadataPath: () => this.metadataPath,
      defaultPartition: this.defaultPartition,
      partition,
      stagingDbPath
    })
  }

  // Why: the staged DB preserves the live Google rows on the live session's behalf. Once the live
  // session no longer has them, that preservation is a resurrection — strip it at the source.
  // Why (#14686): a staged replay snapshots the jar at the START of an import but registers it at
  // the END, so a clear in between must still reach it. Asking "does the jar hold Google cookies
  // now?" cannot answer that — live browsing repopulates it — so registration compares this
  // monotonic per-partition mark against the one taken when the snapshot was made. A counter, not a
  // clock, so a system time change cannot mask a clear.
  /**
   * A mark is ONLY meaningful compared against another mark read earlier in the same process. It is
   * not a "was this ever cleared?" answer: it resets to 0 on restart, so asking that outside an
   * import reads every partition as never-cleared — the exact false negative these exist to prevent.
   * Never persist one, and never compare marks across a restart.
   */
  nonTransplantableClearMark(partition: string): number {
    return this.nonTransplantableClearMarks.get(partition) ?? 0
  }

  /** Same comparability rule as {@link nonTransplantableClearMark}. */
  profileCookieClearMark(partition: string): number {
    return this.profileCookieClearMarks.get(partition) ?? 0
  }

  private bumpProfileCookieClearMark(): void {
    this.profileCookieClearMarks.set(
      this.defaultPartition,
      this.profileCookieClearMark(this.defaultPartition) + 1
    )
  }

  clearPendingCookieImportNonTransplantable(partition: string): void {
    clearPendingBrowserCookieImportNonTransplantable({
      resolveMetadataPath: () => this.metadataPath,
      defaultPartition: this.defaultPartition,
      partition
    })
  }

  // Why: a degraded import still rewrites the live session, so an older staged DB must stop replaying over it.
  clearPendingCookieImport(partition: string): void {
    clearPendingBrowserCookieImport({
      resolveMetadataPath: () => this.metadataPath,
      defaultPartition: this.defaultPartition,
      partition
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

  createProfile(
    scope: BrowserSessionProfileScope,
    label: string,
    options: BrowserSessionProfileCreateOptions = {}
  ): BrowserSessionProfile | null {
    // Why: the registry is also an IPC boundary, so runtime types alone cannot keep invalid values out of persisted metadata.
    if (
      (scope !== 'isolated' && scope !== 'imported') ||
      (options.userAgentMode !== undefined &&
        options.userAgentMode !== 'clean' &&
        options.userAgentMode !== 'native')
    ) {
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
      source: null,
      ...(options.userAgentMode ? { userAgentMode: options.userAgentMode } : {})
    }
    this.profiles.set(id, profile)
    installBrowserSessionPartitionPolicies(profile)
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
    // Why: same leak as the cookie clear — the staged DB is a full copy of this profile's jar, so
    // dropping only the pointer would outlive the profile the user just deleted.
    this.clearPendingCookieImport(profile.partition)

    // Why: clear the partition's storage so deleting a profile doesn't leave orphaned cookies/cache behind.
    try {
      const sess = session.fromPartition(profile.partition)
      clearBrowserSessionUserAgentMode(sess)
      clearBrowserSessionPartitionPolicies(profile.partition, sess)
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
      // Why (#14686): bump on BOTH sides of the await below, because one bump only swaps which half
      // of the wipe window is open. This one covers an import that snapshotted before the wipe and
      // registers during it; the one after the await covers an import that snapshots mid-wipe (its
      // snapshot still holds the pre-wipe rows) and registers later. Only an entire import running
      // inside a single clearStorageData call survives both, which is not reachable.
      // Contrast clearProfileNonTransplantableCookies, which bumps only after its await: that path
      // ends in an UNCONDITIONAL strip of whatever entry exists, so it already covers registrations
      // during its removal. This one drops the entry before the await, so it has no such cover.
      this.bumpProfileCookieClearMark()
      // Why: dropping the metadata pointer inline would leave the staged DB itself on disk — a
      // complete copy of this jar, Google rows included — after we told the user every cookie in
      // the profile was deleted. clearPendingCookieImport unlinks the file and its WAL/SHM too.
      this.clearPendingCookieImport(this.defaultPartition)
      this.persistMeta({ defaultSource: null, pendingCookieDbPath: null })

      const sess = session.fromPartition(this.defaultPartition)
      await sess.clearStorageData({ storages: ['cookies'] })
      // Why: closes the other half — a snapshot taken mid-wipe read the first bump and would
      // otherwise compare equal at registration.
      this.bumpProfileCookieClearMark()
      return true
    } catch {
      return false
    }
  }

  // Why: the same lock owner an import takes, so a clear cannot interleave with one. Only get/remove
  // are needed, so this skips the CDP snapshot store an atomic import clear has to attach.
  async clearProfileNonTransplantableCookies(profileId: string): Promise<boolean> {
    const profile = this.profiles.get(profileId)
    if (!profile) {
      return false
    }
    try {
      const targetSession = session.fromPartition(profile.partition)
      await removeNonTransplantableCookies(targetSession, targetSession.cookies)
      // Why: bump only after the live removal succeeded, so a failed clear cannot make a staged
      // replay look stale and discard rows the user never cleared. Bump BEFORE the strip below and
      // keep that order: an import registering between the two sees the changed mark and strips
      // itself, whereas strip-then-bump would let it register after the strip and skip.
      this.nonTransplantableClearMarks.set(
        profile.partition,
        this.nonTransplantableClearMark(profile.partition) + 1
      )
      // Why: a pending staged DB carries the pre-clear rows of this very family, so clearing only
      // the live session would hand the session back at the next cold start.
      clearPendingBrowserCookieImportNonTransplantable({
        resolveMetadataPath: () => this.metadataPath,
        defaultPartition: this.defaultPartition,
        partition: profile.partition
      })
      return true
    } catch {
      return false
    }
  }

  hydrateFromPersisted(profiles: BrowserSessionProfile[]): void {
    for (const profile of profiles) {
      if (!isValidPersistedBrowserSessionProfile(profile, this.activeOrcaProfileId)) {
        continue
      }
      this.profiles.set(profile.id, profile)
      if (profile.partition !== this.defaultPartition) {
        installBrowserSessionPartitionPolicies(profile)
      }
    }
  }
}

export const browserSessionRegistry = new BrowserSessionRegistry()
