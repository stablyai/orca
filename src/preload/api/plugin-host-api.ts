import type { PluginHostImages } from '../../shared/plugins/plugin-image-url'
import type { PluginUpdateAccessGrowth } from '../../shared/plugins/approval/plugin-update-access-growth'
import type { PluginAutoUpdateState } from '../../shared/plugins/catalog/plugin-update-policy'
import type { PluginExecutionProfile } from '../../shared/plugins/plugin-execution-profile'
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
import type {
  PluginPanelActionOutcome,
  PluginPanelEntry
} from '../../shared/plugins/plugin-panel-bridge'
import type { PluginConsentRequest } from '../../shared/plugins/approval/plugin-consent-request'
import type { PluginLanguagePackRegistration } from '../../shared/plugins/artifacts/plugin-language-pack-artifact'
import type { PluginChangeEvent } from '../../shared/plugins/plugin-change-event'
import type { PluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import type { PluginMarketplaceGitSource } from '../../shared/plugins/catalog/plugin-marketplace'
import type { PluginCatalogRelease } from '../../shared/plugins/catalog/plugin-catalog-release'

export type PluginHostPanel = {
  id: string
  title: string
  /** Lucide icon name declared in the plugin manifest. */
  icon?: string
  tabKey: `plugin:${string}`
}

/** pending awaits consent; idle defers worker startup; errored exhausted retries or failed startup. */
export type PluginHostStatus =
  | 'running'
  | 'restarting'
  | 'idle'
  | 'pending'
  | 'disabled'
  | 'errored'
  | 'invalid'

// Keep assignable from main/plugins/plugin-list-projection.ts.
export type PluginHostListEntry = {
  pluginKey: string
  consentFingerprint: string | null
  name: string
  version: string
  publisher: string
  description?: string
  /** The verified execution profile from the installed manifest; absent for invalid entries and
   *  on hosts that predate it. Never infer it from the plugin's contents. */
  execution?: PluginExecutionProfile
  /** Declared images (format 2 manifests), as orca-plugin-image URLs main serves. */
  images?: PluginHostImages
  /** SPDX license expression from the manifest. */
  license?: string
  homepage?: string
  repository?: string
  status: PluginHostStatus
  needsReconsent: boolean
  error?: string
  isDev: boolean
  official: boolean
  bundled: boolean
  capabilities: { kind: string; description: string }[]
  panels: PluginHostPanel[]
  commands: {
    id: string
    title: string
    // Why `worktree`: hosts from before the rename to `workspace` still send it.
    context: 'global' | 'workspace' | 'worktree'
    handler: { type: 'built-in'; action: string } | { type: 'worker' }
    keybindings: { key: string; when: 'global' | 'workspace' | 'worktree' }[]
  }[]
  hasWorker: boolean
  vmRecipes?: {
    id: string
    name: string
    description?: string
    commands: {
      phase: 'create' | 'suspend' | 'resume' | 'destroy'
      command: string
    }[]
  }[]
  restarts: number
  blockedByKillList?: { reason: string; advisoryUrl?: string }
  source?: {
    kind: 'local-path' | 'git' | 'marketplace' | 'bundled'
    reference: string
    resolvedCommit: string | null
    contentHash: string
    /** `ref` is the catalog's ref, so a client can join to the exact catalog source. */
    marketplace?: { reference: string; ref?: string; resolvedCommit: string }
  }
}

export type PluginHostLogLine = {
  ts: number
  level: 'info' | 'warn' | 'error'
  line: string
}

export type PluginHostInstallSource =
  | { kind: 'local-path'; path: string }
  | { kind: 'git'; url: string; ref: string }

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
  source: PluginMarketplaceGitSource
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
  source: PluginMarketplaceGitSource
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
  readPanelEntry: (args: { pluginKey: string; panelId: string }) => Promise<PluginPanelEntry | null>
  invokeCommand: (args: {
    pluginKey: string
    commandId: string
    args?: unknown
  }) => Promise<unknown>
  /** Main enforces consented capabilities before executing sandboxed panel requests. */
  panelAction: (args: {
    sessionToken: string
    action: string
    params?: unknown
  }) => Promise<PluginPanelActionOutcome>
  install: (source: PluginHostInstallSource) => Promise<PluginHostInstallResult>
  listMarketplaces: () => Promise<PluginMarketplaceHostSourceState[]>
  addMarketplace: (source: PluginMarketplaceGitSource) => Promise<PluginMarketplaceHostSourceState>
  removeMarketplace: (args: { sourceId: string }) => Promise<PluginMarketplaceHostSourceState[]>
  refreshMarketplaces: (args?: { sourceId?: string }) => Promise<PluginMarketplaceHostSourceState[]>
  listMarketplacePlugins: () => Promise<PluginMarketplaceHostListing[]>
  /** A catalog plugin that opens this file type, from cached catalogs only; never installs. */
  suggestForFileType: (fileType: string) => Promise<PluginFileTypeHostSuggestion | null>
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
  /** Fires after each automatic update pass, with the plugins it just updated. */
  onAutoUpdateChanged: (callback: (event: PluginAutoUpdateEvent) => void) => () => void
}

export type PluginAutoUpdateEvent = {
  state: PluginAutoUpdateState
  updated: { pluginKey: string; name: string; version: string }[]
}
