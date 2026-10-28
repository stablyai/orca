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
  BrowserSessionProfileScope
} from '../../shared/browser-workspace-types'
import {
  applyPendingBrowserCookieImports,
  clearPendingBrowserCookieImport
} from './browser-session-cookie-staging'
import {
  BROWSER_SESSION_META_FILE_NAME,
  forgetBrowserSessionProfileMeta,
  loadBrowserSessionMeta,
  persistBrowserSessionMeta
} from './browser-session-meta-store'
import type { BrowserSessionMeta } from './browser-session-meta-store'
import { installBrowserSessionPartitionPolicies } from './browser-session-partition-policies'
import {
  isValidPersistedBrowserSessionProfile,
  inspectRetiredBrowserSessionProfileUserAgentModes
} from './browser-session-persisted-profile-validation'
import {
  clearBrowserRoutePartitionPolicies,
  installBrowserRoutePartitionPolicies
} from './browser-session-route-policies'
import {
  retireDeletedBrowserSessionProfile,
  retireFailedBrowserSessionProfile
} from './browser-session-profile-retirement'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { markBrowserIdentityMigrationNoticePending } from './browser-identity-mode-store'
import { forgetBrowserSitePermissions } from './browser-site-permission-store'
import { forgetBrowserSiteDisplay } from './browser-site-display-store'
import { attachBrowserExtensionsToProfileSession } from './extensions/browser-extension-session-loader'

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

  private persistProfiles(): void {
    const nonDefault = [...this.profiles.values()].filter((p) => p.id !== 'default')
    this.persistMeta({ profiles: nonDefault })
  }

  private loadPersistedMeta(): BrowserSessionMeta {
    return loadBrowserSessionMeta(() => this.metadataPath, this.defaultPartition)
  }

  // Restore profiles and their policies before any webview loads.
  initializeBrowserSessionsFromPersistedState(): void {
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
    if (meta.profiles.length > 0) {
      this.hydrateFromPersisted(meta.profiles, meta.enabledExtensionIdsByProfileId)
    }

    // Hydration skips the default profile, so install its policies separately.
    const defaultProfile = this.getDefaultProfile()
    void installBrowserSessionPartitionPolicies(defaultProfile).catch(() => {
      console.warn('[proxy] Failed to apply proxy to browser partition', defaultProfile.partition)
    })
    this.attachExtensions(defaultProfile, meta.enabledExtensionIdsByProfileId.default ?? [])
  }

  // Why here and not in the partition installer: that installer also serves route, SSH and
  // doc-preview partitions, and release 1 runs extensions only in local browser profiles.
  private attachExtensions(
    profile: BrowserSessionProfile,
    enabledExtensionIds = this.getEnabledExtensionIds(profile.id)
  ): void {
    attachBrowserExtensionsToProfileSession(profile, enabledExtensionIds)
  }

  getEnabledExtensionIds(profileId: string): string[] {
    return this.loadPersistedMeta().enabledExtensionIdsByProfileId[profileId] ?? []
  }

  updateEnabledExtensionIds(update: ExtensionIdListUpdate): void {
    this.updateExtensionIdList('enabledExtensionIdsByProfileId', update)
  }

  getPinnedExtensionIds(profileId: string): string[] {
    return this.loadPersistedMeta().pinnedExtensionIdsByProfileId[profileId] ?? []
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
    this.attachExtensions(profile)
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
      this.persistSource(source)
    } else {
      this.persistProfiles()
    }
    this.onProfilesChanged?.()
    return updated
  }

  async deleteProfile(profileId: string): Promise<boolean> {
    const profile = this.profiles.get(profileId)
    if (!profile || profile.scope === 'default') {
      return false
    }
    this.profiles.delete(profileId)
    this.persistProfiles()
    this.onProfilesChanged?.()
    forgetBrowserSitePermissions(profileId)
    forgetBrowserSiteDisplay(profileId)
    this.persistMeta(
      forgetBrowserSessionProfileMeta(this.loadPersistedMeta(), profile, this.defaultPartition)
    )
    await retireDeletedBrowserSessionProfile(profile)
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

      const sess = session.fromPartition(this.defaultPartition)
      await sess.clearStorageData({ storages: ['cookies'] })
      return true
    } catch {
      return false
    }
  }

  hydrateFromPersisted(
    profiles: BrowserSessionProfile[],
    enabledExtensionIdsByProfileId = this.loadPersistedMeta().enabledExtensionIdsByProfileId
  ): void {
    for (const profile of profiles) {
      if (!isValidPersistedBrowserSessionProfile(profile, this.activeOrcaProfileId)) {
        continue
      }
      this.profiles.set(profile.id, profile)
      if (profile.partition !== this.defaultPartition) {
        void installBrowserSessionPartitionPolicies(profile).catch(() => {
          console.warn('[proxy] Failed to apply proxy to browser partition', profile.partition)
        })
        this.attachExtensions(profile, enabledExtensionIdsByProfileId[profile.id] ?? [])
      }
    }
  }
}

export const browserSessionRegistry = new BrowserSessionRegistry()
