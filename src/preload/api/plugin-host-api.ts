import type {
  PluginPanelActionOutcome,
  PluginPanelEntry
} from '../../shared/plugins/plugin-panel-bridge'
import type { PluginConsentRequest } from '../../shared/plugins/plugin-consent-request'
import type { PluginLanguagePackRegistration } from '../../shared/plugins/plugin-language-pack-artifact'
import type { PluginChangeEvent } from '../../shared/plugins/plugin-change-event'
import type { PluginManifest } from '../../shared/plugins/plugin-manifest'
import type { PluginMarketplaceGitSource } from '../../shared/plugins/plugin-marketplace'

/** Panel contribution as surfaced by the main-process plugin service. */
export type PluginHostPanel = {
  id: string
  title: string
  /** Lucide icon name declared in the plugin manifest. */
  icon?: string
  tabKey: `plugin:${string}`
}

/** `pending` = awaiting (re-)consent; `idle` = enabled, worker not running
 *  (lazy); `restarting` = waiting for supervised backoff; `errored` = crashed past the restart budget or failed to start;
 *  `invalid` = unreadable manifest. */
export type PluginHostStatus =
  | 'running'
  | 'restarting'
  | 'idle'
  | 'pending'
  | 'disabled'
  | 'errored'
  | 'invalid'

/** Wire shape of plugins:list — must stay assignable from the main-process
 *  projection in src/main/plugins/plugin-list-projection.ts. */
export type PluginHostListEntry = {
  pluginKey: string
  consentFingerprint: string | null
  name: string
  version: string
  publisher: string
  description?: string
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
    context: 'global' | 'worktree'
    handler: { type: 'built-in'; action: string } | { type: 'worker' }
    keybindings: { key: string; when: 'global' | 'worktree' }[]
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
    marketplace?: { reference: string; resolvedCommit: string }
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
}

export type PluginsApi = {
  list: () => Promise<PluginHostListEntry[]>
  listLanguagePacks: () => Promise<PluginLanguagePackRegistration[]>
  /** Records the consent-dialog answer; approval is keyed to the plugin's
   *  current capability and trusted-worker fingerprint. */
  consent: (args: PluginConsentRequest) => Promise<PluginHostListEntry[]>
  setEnabled: (args: { pluginKey: string; enabled: boolean }) => Promise<PluginHostListEntry[]>
  /** Returns the panel's CSP-wrapped HTML, or null when the plugin or
   *  panel is missing/disabled. Rendered only inside a sandboxed iframe. */
  readPanelEntry: (args: { pluginKey: string; panelId: string }) => Promise<PluginPanelEntry | null>
  invokeCommand: (args: {
    pluginKey: string
    commandId: string
    args?: unknown
  }) => Promise<unknown>
  /** Relays a sandboxed panel's bridge request to main, which enforces the
   *  plugin's consented capabilities before executing. */
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
  previewMarketplacePlugin: (args: {
    marketplaceSourceId: string
    pluginKey: string
  }) => Promise<PluginMarketplaceHostInstallPreview>
  installMarketplacePlugin: (
    preview: Pick<
      PluginMarketplaceHostInstallPreview,
      'marketplaceSourceId' | 'marketplaceCommit' | 'pluginKey' | 'resolvedCommit'
    >
  ) => Promise<PluginHostInstallResult>
  previewMarketplaceUpdate: (args: {
    pluginKey: string
  }) => Promise<PluginMarketplaceHostInstallPreview>
  rollbackMarketplacePlugin: (args: { pluginKey: string }) => Promise<PluginHostInstallResult>
  remove: (args: { pluginKey: string }) => Promise<PluginHostListEntry[]>
  getLogs: (args: { pluginKey: string }) => Promise<PluginHostLogLine[]>
  /** Re-discovers after settings edits (feature flag, dev paths). */
  refresh: () => Promise<PluginHostListEntry[]>
  /** Fires whenever installed plugins, worker states, panels, or content packs change. */
  onChanged: (callback: (event: PluginChangeEvent) => void) => () => void
}
