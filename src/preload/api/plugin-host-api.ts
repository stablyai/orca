import type { PluginHostImages } from '../../shared/plugins/images/plugin-image-url'
import type { PluginUpdateAccessGrowth } from '../../shared/plugins/approval/plugin-update-access-growth'
import type {
  PluginAutoUpdateState,
  PluginUpdateReviewNotice
} from '../../shared/plugins/catalog/plugin-update-policy'
import type {
  PluginIconThemeMetadata,
  PluginIconThemeRegistration
} from '../../shared/plugins/artifacts/plugin-icon-theme-artifact'
import type { PluginThemeRegistration } from '../../shared/plugins/artifacts/plugin-theme-artifact'
import type {
  PluginSyntaxMetadata,
  PluginSyntaxPayload
} from '../../shared/plugins/artifacts/plugin-syntax-artifact'
import type { PluginTerminalThemeRegistration } from '../../shared/plugins/artifacts/plugin-terminal-theme-artifact'
import type { PluginFrameEntry } from '../../shared/plugins/frames/plugin-frame-bridge'
import type { PluginHostCallOutcome } from '../../shared/plugins/frames/plugin-protocol'
import type { PluginConsentRequest } from '../../shared/plugins/approval/plugin-consent-request'
import type { PluginLanguagePackRegistration } from '../../shared/plugins/artifacts/plugin-language-pack-artifact'
import type { PluginChangeEvent } from '../../shared/plugins/events/plugin-change-event'
import type { PluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import type {
  PluginCatalogGitSource,
  PluginMarketplaceGitSource
} from '../../shared/plugins/catalog/plugin-marketplace'
import type { PluginCatalogRelease } from '../../shared/plugins/catalog/plugin-catalog-release'
import type { PluginGitSourceResolution } from '../../shared/plugins/installation/plugin-git-resolution'

export type {
  PluginHostCustomEditor,
  PluginHostListEntry,
  PluginHostNewFile,
  PluginHostPanel,
  PluginHostStatus
} from '../../shared/plugins/plugin-list-entry'
import type { PluginHostListEntry } from '../../shared/plugins/plugin-list-entry'

export type PluginHostLogLine = {
  ts: number
  level: 'info' | 'warn' | 'error'
  line: string
}

export type PluginHostInstallSource =
  | { kind: 'local-path'; path: string }
  | { kind: 'git'; url: string; ref: string; expectedCommit?: string }

export type PluginHostInstallResult =
  | {
      ok: true
      pluginKey: string
      version: string
      contentHash: string
      consentFingerprint: string
      resolvedCommit: string | null
      /** Set when install was asked to enable a content-only plugin: false means it is on;
       *  true means it runs or adds instructions, so it waits for review. */
      needsReview?: boolean
    }
  | { ok: false; error: string }

export type PluginMarketplaceHostSourceState = {
  id: string
  source: PluginMarketplaceGitSource
  addedAt: number
  marketplace: {
    name: string
    owner: string
    resolvedCommit: string
    fetchedAt: number
  } | null
  stale: boolean
  official: boolean
  error?: string
}

export type PluginMarketplaceHostListing = {
  marketplaceSourceId: string
  marketplaceName: string
  marketplaceOwner: string
  marketplaceCommit: string
  pluginKey: string
  source: PluginCatalogGitSource
  description?: string
  categories: string[]
  official: boolean
  bundled: boolean
  blockedByKillList?: { reason: string; advisoryUrl?: string }
  /** The release record a v2 catalog vouches for; absent for v1 catalogs. */
  release?: PluginCatalogRelease
  /** The offered release's images, verified and cached by main; never hotlinked. */
  images?: PluginHostImages
  /** Release details from a v2 catalog; all absent for v1 catalogs. */
  name?: string
  version?: string
  license?: string
  repository?: string
  homepage?: string
  /** ISO 8601 date or date-time the release was published. */
  updatedAt?: string
  /** Plain-text release notes, at most 2000 characters. */
  changelog?: string
}

export type PluginFileTypeHostSuggestion = {
  marketplaceSourceId: string
  pluginKey: string
  fileType: string
  name?: string
}

export type PluginMarketplaceHostInstallPreview = {
  marketplaceSourceId: string
  marketplaceName: string
  marketplaceOwner: string
  marketplaceCommit: string
  pluginKey: string
  source: PluginCatalogGitSource
  resolvedCommit: string
  contentHash: string
  consentFingerprint: string
  manifest: PluginManifest
  official: boolean
  bundled: boolean
  blockedByKillList?: { reason: string; advisoryUrl?: string }
  /** The manifest's images, verified at preview. */
  images?: PluginHostImages
  /** For an update: what it asks for beyond the installed version. */
  accessGrowth?: PluginUpdateAccessGrowth
  /** For an update: the catalog now points at a different repository than the install. */
  repositoryMoved?: true
}

export type PluginsApi = {
  list: () => Promise<PluginHostListEntry[]>
  listLanguagePacks: () => Promise<PluginLanguagePackRegistration[]>
  listThemes: () => Promise<PluginThemeRegistration[]>
  listTerminalThemes: () => Promise<PluginTerminalThemeRegistration[]>
  listIconThemes: () => Promise<PluginIconThemeMetadata[]>
  /** One icon theme's images, read only once it is selected. */
  loadIconTheme: (id: string) => Promise<PluginIconThemeRegistration | null>
  listSyntaxes: () => Promise<PluginSyntaxMetadata[]>
  /** One language's grammars, read only once a matching file opens. */
  loadSyntax: (id: string) => Promise<PluginSyntaxPayload | null>
  /** Approval is bound to the current capability and trusted-worker fingerprint. */
  consent: (args: PluginConsentRequest) => Promise<PluginHostListEntry[]>
  setEnabled: (args: { pluginKey: string; enabled: boolean }) => Promise<PluginHostListEntry[]>
  /** CSP-wrapped HTML for a sandboxed iframe; null if missing or disabled. */
  readPanelEntry: (args: { pluginKey: string; panelId: string }) => Promise<PluginFrameEntry | null>
  /** CSP-wrapped custom editor HTML and its host-call session; null if missing or disabled. */
  readCustomEditorEntry?: (args: {
    pluginKey: string
    editorId: string
  }) => Promise<PluginFrameEntry | null>
  /** A new file's starting text (its template, or empty); null if the plugin is off or lacks it. */
  readNewFileTemplate?: (args: { pluginKey: string; newFileId: string }) => Promise<string | null>
  invokeCommand: (args: {
    pluginKey: string
    commandId: string
    args?: unknown
  }) => Promise<unknown>
  /** One frame host call; main enforces consented capabilities and the frame's surface. */
  panelAction: (args: {
    sessionToken: string
    action: string
    params?: unknown
  }) => Promise<PluginHostCallOutcome>
  /** Pins a Git install input to an exact commit without downloading it. */
  resolveGitSource: (args: { url: string; ref: string }) => Promise<PluginGitSourceResolution>
  install: (source: PluginHostInstallSource) => Promise<PluginHostInstallResult>
  listMarketplaces: () => Promise<PluginMarketplaceHostSourceState[]>
  addMarketplace: (source: PluginMarketplaceGitSource) => Promise<PluginMarketplaceHostSourceState>
  removeMarketplace: (args: { sourceId: string }) => Promise<PluginMarketplaceHostSourceState[]>
  refreshMarketplaces: (args?: { sourceId?: string }) => Promise<PluginMarketplaceHostSourceState[]>
  listMarketplacePlugins: () => Promise<PluginMarketplaceHostListing[]>
  /** A catalog plugin that opens this file type, from cached catalogs only; never installs. */
  /** `editor` for a file Orca already opens as text: only custom editors are suggested. */
  suggestForFileType: (
    fileType: string,
    purpose?: 'open' | 'editor'
  ) => Promise<PluginFileTypeHostSuggestion | null>
  previewMarketplacePlugin: (args: {
    marketplaceSourceId: string
    pluginKey: string
  }) => Promise<PluginMarketplaceHostInstallPreview>
  /** With `enableIfData`, main also turns the plugin on when the installed manifest is
   *  `execution: 'data'` and, if given, its fingerprint is `expectedFingerprint`; anything else
   *  comes back `needsReview: true`. Older hosts ignore both fields. */
  installMarketplacePlugin: (
    preview: Pick<
      PluginMarketplaceHostInstallPreview,
      'marketplaceSourceId' | 'marketplaceCommit' | 'pluginKey' | 'resolvedCommit'
    > & {
      enableIfData?: true
      /** The preview's consentFingerprint; with it, main approves only those exact bytes. */
      expectedFingerprint?: string
      /** The page was opened from an install link; only labels telemetry. */
      fromInstallLink?: true
    }
  ) => Promise<PluginHostInstallResult>
  previewMarketplaceUpdate: (args: {
    pluginKey: string
  }) => Promise<PluginMarketplaceHostInstallPreview>
  rollbackMarketplacePlugin: (args: { pluginKey: string }) => Promise<PluginHostInstallResult>
  /** Version a rollback would restore, or null. Read on demand so listing plugins stays I/O-free. */
  getRollbackVersion: (args: { pluginKey: string }) => Promise<string | null>
  /** An installed plugin's parsed manifest, read on demand; works while the plugin system is off. */
  getInstalledManifest: (args: { pluginKey: string }) => Promise<PluginManifest | null>
  remove: (args: { pluginKey: string }) => Promise<PluginHostListEntry[]>
  getLogs: (args: { pluginKey: string }) => Promise<PluginHostLogLine[]>
  /** Re-discovers after settings edits (feature flag, dev paths). */
  refresh: () => Promise<PluginHostListEntry[]>
  onChanged: (callback: (event: PluginChangeEvent) => void) => () => void
  /** What automatic updates last did. Older hosts reject the call; treat that as nothing. */
  getAutoUpdateState: () => Promise<PluginAutoUpdateState>
  /** Held updates not yet told to the user, each returned once per version; never approves. */
  takeUpdateReviewNotices: () => Promise<PluginUpdateReviewNotice[]>
  /** Public install counts by plugin key, display only; empty when unknown. Older hosts reject. */
  getInstallCounts: () => Promise<Record<string, number>>
  onInstallCountsChanged: (callback: () => void) => () => void
  /** Fires after each automatic update pass, with the plugins it just updated. */
  onAutoUpdateChanged: (callback: (event: PluginAutoUpdateEvent) => void) => () => void
}

export type PluginAutoUpdateEvent = {
  state: PluginAutoUpdateState
  updated: { pluginKey: string; name: string; version: string }[]
}
