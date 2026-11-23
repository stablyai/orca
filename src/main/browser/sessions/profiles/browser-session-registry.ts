import { app, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import '../../../../shared/orca-profiles/constants'
import { ORCA_BROWSER_PARTITION } from '../../../../shared/browser/browser-session-partition'
import {
  DEFAULT_LOCAL_ORCA_PROFILE_ID,
  getOrcaProfileBrowserDefaultPartition,
  getOrcaProfileBrowserSessionPartition
} from '../../../../shared/orca-profiles/orca-profiles'
import type {
  BrowserSessionProfile,
  BrowserSessionProfileScope
} from '../../../../shared/browser/workspaces/browser-workspace-types'
import {
  applyPendingBrowserCookieImports,
  clearPendingBrowserCookieImport
} from '../../cookies/staging/browser-session-cookie-staging'
import {
  BROWSER_SESSION_META_FILE_NAME,
  didReadBrowserSessionMeta,
  forgetBrowserSessionProfileMeta,
  getCachedBrowserExtensionEnabledIds,
  loadBrowserSessionMeta,
  persistBrowserSessionMeta,
  type BrowserSessionMeta
} from './browser-session-meta-store'
import { installBrowserSessionPartitionPolicies } from '../partition-policies/browser-session-partition-policies'
import { isValidPersistedBrowserSessionProfile } from './browser-session-persisted-profile-validation'
import { inspectRetiredBrowserSessionProfileUserAgentModes } from '../../identity/mode/browser-retired-profile-identity-inspection'
import {
  clearBrowserRoutePartitionPolicies,
  installBrowserRoutePartitionPolicies
} from '../../routing/sessions/browser-session-route-policies'
import {
  retireDeletedBrowserSessionProfile,
  retireFailedBrowserSessionProfile
} from './browser-session-profile-retirement'
import { getCanonicalUserDataPath } from '../../../persistence/loading-store/user-data-path'
import { markBrowserIdentityMigrationNoticePending } from '../../identity/mode/browser-identity-mode-store'
import { forgetBrowserProfileOwnedStores } from './browser-profile-owned-stores'
import {
  attachBrowserExtensionsToProfileSession,
  getBrowserExtensionSessionForProfile
} from '../../extensions/profile-sessions/browser-extension-session-loader'
import {
  browserExtensionRouteSessionProfile as routeSessionProfile,
  browserExtensionSourceProfileId as sourceProfileId
} from '../../extensions/profile-sessions/browser-extension-route-profiles'
import { isBrowserExtensionSupportEnabled } from '../../extensions/browser-extension-support'
import { trackBrowserSessionCookies } from '../../cookies/session-restore/browser-session-cookie-restore'
import { clearBrowserCookieJar } from '../../cookies/session-restore/browser-session-cookie-clear'

type ExtensionIdListKey = 'enabledExtensionIdsByProfileId' | 'pinnedExtensionIdsByProfileId'
type ExtensionIdListUpdate = (byProfile: Record<string, string[]>) => Record<string, string[]>

export type BrowserSessionRegistryProfileOptions = {
  orcaProfileId: string
  profileDirectory: string
}

// This registry supplies the partition allowlist used by will-attach-webview.

class BrowserSessionRegistry {
  private readonly profiles = new Map<string, BrowserSessionProfile>()
  private activeOrcaProfileId = DEFAULT_LOCAL_ORCA_PROFILE_ID
  private metadataPathOverride: string | null = null
  private defaultPartition = ORCA_BROWSER_PARTITION
  // Why: profiles change from IPC, the CLI and managed-profile owners; open windows and paired clients only learn of it here.
  onProfilesChanged: (() => void) | null = null
  onProfileDeleted: ((profileId: string) => Promise<void>) | null = null

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
    this.profiles.set('default', {
      id: 'default',
      scope: 'default',
      partition: this.defaultPartition,
      label: 'Default',
      source: this.loadPersistedMeta().defaultSource
    })
  }

  private get metadataPath(): string {
    return (
      this.metadataPathOverride ?? join(app.getPath('userData'), BROWSER_SESSION_META_FILE_NAME)
    )
  }

  private persistMeta(updates: Partial<BrowserSessionMeta>): void {
    persistBrowserSessionMeta(() => this.metadataPath, this.defaultPartition, updates)
  }

  private persistProfiles(): void {
    const nonDefault = [...this.profiles.values()].filter((p) => p.id !== 'default')
    this.persistMeta({ profiles: nonDefault })
  }

  private loadPersistedMeta(): BrowserSessionMeta {
    return loadBrowserSessionMeta(() => this.metadataPath, this.defaultPartition)
  }

  // Restore profiles and their policies before any webview loads; false when the saved profiles could not be read.
  initializeBrowserSessionsFromPersistedState(): boolean {
    const meta = this.loadPersistedMeta()
    const migration = inspectRetiredBrowserSessionProfileUserAgentModes(
      meta.profiles,
      this.activeOrcaProfileId
    )
    if (migration.noticePending) {
      // Migration bookkeeping must not block session startup.
      void markBrowserIdentityMigrationNoticePending(
        getCanonicalUserDataPath(),
        migration.degraded
      ).catch((error) => console.error('[browser-identity] Migration notice failed:', error))
    }
    if (meta.defaultSource) {
      const current = this.profiles.get('default')
      if (current && current.source === null) {
        this.profiles.set('default', { ...current, source: meta.defaultSource })
      }
    }
    const hydrated = this.hydrateFromPersisted(meta.profiles)

    // Hydration skips the default profile, so install its policies separately.
    const defaultProfile = this.getDefaultProfile()
    void installBrowserSessionPartitionPolicies(defaultProfile).catch(() => {
      console.warn('[proxy] Failed to apply proxy to browser partition', defaultProfile.partition)
    })
    return hydrated && didReadBrowserSessionMeta(this.metadataPath)
  }

  /**
   * Starts a profile's extensions when it gets a page or Settings acts on them, never at launch, and
   * they stop once it has none. A local profile, or an SSH or This-device page's session running a
   * local profile's extensions; never a doc preview.
   */
  attachExtensions(profileId: string): void {
    const profile = this.profiles.get(profileId) ?? routeSessionProfile(profileId)
    // Why these first: the enabled list is read from disk, and this runs for every new tab.
    if (
      profile &&
      isBrowserExtensionSupportEnabled() &&
      !getBrowserExtensionSessionForProfile(profileId)
    ) {
      attachBrowserExtensionsToProfileSession(profile, this.getEnabledExtensionIds(profileId))
    }
  }

  /** A remote page's session uses its local profile's list. */
  getEnabledExtensionIds(pageProfileId: string): string[] {
    const profileId = sourceProfileId(pageProfileId)
    const cached = getCachedBrowserExtensionEnabledIds(this.metadataPath, profileId)
    return cached ?? this.loadPersistedMeta().enabledExtensionIdsByProfileId[profileId] ?? []
  }

  updateEnabledExtensionIds(update: ExtensionIdListUpdate): void {
    this.updateExtensionIdList('enabledExtensionIdsByProfileId', update)
  }

  getPinnedExtensionIds(profileId: string): string[] {
    return this.loadPersistedMeta().pinnedExtensionIdsByProfileId[sourceProfileId(profileId)] ?? []
  }

  updatePinnedExtensionIds(update: ExtensionIdListUpdate): void {
    this.updateExtensionIdList('pinnedExtensionIdsByProfileId', update)
  }

  private updateExtensionIdList(key: ExtensionIdListKey, update: ExtensionIdListUpdate): void {
    this.persistMeta({ [key]: update(this.loadPersistedMeta()[key]) })
  }

  applyPendingCookieImport(): void {
    applyPendingBrowserCookieImports({
      resolveMetadataPath: () => this.metadataPath,
      defaultPartition: this.defaultPartition,
      activeOrcaProfileId: this.activeOrcaProfileId
    })
  }

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

  /** Called after startup has materialized the known profile sessions. */
  profileIdForSession(candidate: Electron.Session): string | null {
    return (
      this.listProfiles().find((p) => session.fromPartition(p.partition) === candidate)?.id ?? null
    )
  }

  /** The local browser profile a partition belongs to; tabs attach only in these. */
  profileIdForPartition(partition: string): string | null {
    return this.listProfiles().find((p) => p.partition === partition)?.id ?? null
  }

  resolvePartition(profileId: string | null | undefined): string {
    return this.resolveKnownPartition(profileId) ?? this.defaultPartition
  }

  resolveKnownPartition(profileId: string | null | undefined): string | null {
    if (!profileId) {
      return this.defaultPartition
    }
    return this.profiles.get(profileId)?.partition ?? null
  }

  setupRoutePartitionPolicies(partition: string, browserProfileId: string): Promise<void> {
    const profile = this.profiles.get(browserProfileId)
    if (!profile) {
      throw new Error('browser_route_partition_profile_unavailable')
    }
    return installBrowserRoutePartitionPolicies(profile, partition)
  }

  requireRouteBrowserProfile(browserProfileId: string): void {
    if (!this.profiles.has(browserProfileId)) {
      throw new Error('browser_route_partition_profile_unavailable')
    }
  }

  clearRoutePartitionPolicies(partition: string): void {
    clearBrowserRoutePartitionPolicies(partition)
  }

  async createProfile(
    scope: BrowserSessionProfileScope,
    label: string,
    owner?: BrowserSessionProfile['owner']
  ): Promise<BrowserSessionProfile | null> {
    // IPC callers can pass values outside the TypeScript scope union.
    if (scope !== 'isolated' && scope !== 'imported') {
      return null
    }
    const id = randomUUID()
    const partition = getOrcaProfileBrowserSessionPartition(this.activeOrcaProfileId, id)
    const profile: BrowserSessionProfile = { id, scope, partition, label, source: null, owner }
    try {
      await installBrowserSessionPartitionPolicies(profile)
    } catch (error) {
      await retireFailedBrowserSessionProfile(partition, session.fromPartition(partition))
      throw error
    }
    this.profiles.set(id, profile)
    this.persistProfiles()
    trackBrowserSessionCookies(profile)
    this.onProfilesChanged?.()
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
      this.persistMeta({ defaultSource: source })
    } else {
      this.persistProfiles()
    }
    this.onProfilesChanged?.()
    return updated
  }

  async deleteProfile(profileId: string): Promise<boolean> {
    const profile = this.profiles.get(profileId)
    if (!profile || profile.scope === 'default' || !forgetBrowserProfileOwnedStores(profileId)) {
      return false
    }
    this.profiles.delete(profileId)
    this.persistProfiles()
    this.onProfilesChanged?.()
    this.persistMeta(
      forgetBrowserSessionProfileMeta(this.loadPersistedMeta(), profile, this.defaultPartition)
    )
    await retireDeletedBrowserSessionProfile(profile, () => this.onProfileDeleted?.(profileId))
    return true
  }

  async clearDefaultSessionCookies(): Promise<boolean> {
    try {
      // Clear import metadata first so quitting during storage cleanup cannot leave a stale source badge.
      const defaultProfile = this.profiles.get('default')
      if (defaultProfile) {
        this.profiles.set('default', { ...defaultProfile, source: null })
      }
      const meta = this.loadPersistedMeta()
      const pendingCookieImports = { ...meta.pendingCookieImports }
      delete pendingCookieImports[this.defaultPartition]
      this.persistMeta({
        defaultSource: null,
        pendingCookieDbPath: null,
        pendingCookieImports
      })
      this.onProfilesChanged?.()

      await clearBrowserCookieJar(session.fromPartition(this.defaultPartition))
      return true
    } catch {
      return false
    }
  }

  /** False when it rejected an entry: a profile on disk the registry lacks, not a deleted one. */
  hydrateFromPersisted(profiles: BrowserSessionProfile[]): boolean {
    const valid = profiles.filter((profile) =>
      isValidPersistedBrowserSessionProfile(profile, this.activeOrcaProfileId)
    )
    for (const profile of valid) {
      this.profiles.set(profile.id, profile)
      if (profile.partition !== this.defaultPartition) {
        void installBrowserSessionPartitionPolicies(profile).catch(() => {
          console.warn('[proxy] Failed to apply proxy to browser partition', profile.partition)
        })
      }
    }
    return valid.length === profiles.length
  }
}

export const browserSessionRegistry = new BrowserSessionRegistry()
