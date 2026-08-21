import {
  PLUGIN_CAPABILITY_DESCRIPTIONS,
  type PluginCapabilityKind
} from '../../shared/plugins/plugin-capabilities'
import { needsReconsent } from '../../shared/plugins/plugin-consent-state'
import { pluginPanelTabKey } from '../../shared/plugins/plugin-manifest'
import type { PluginLockfile } from '../../shared/plugins/plugin-install-lockfile'
import { isInvalidDiscoveredPlugin } from './plugin-discovery'
import type { PluginService } from './plugin-service'
import { listPluginVmRecipeCommands } from '../../shared/plugins/plugin-vm-recipe-artifact'
import type { PluginCommandAliasActionId } from '../../shared/plugins/plugin-command-actions'
import {
  isOfficialMarketplaceGitSource,
  isOfficialOrganizationGitSource,
  isOfficialPluginIdentity
} from '../../shared/plugins/plugin-marketplace'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'

const PLUGIN_LIST_PROJECTION_CONCURRENCY = 4

/**
 * Wire projection of installed plugins for the renderer and serve RPC.
 * `invalid` = unreadable/failed manifest; `pending` = awaiting (re-)consent;
 * `idle` = enabled with no worker running (lazy); `restarting` = waiting for
 * supervised backoff; `errored` = crashed past the budget or failed to activate.
 */

export type PluginListPanelEntry = {
  id: string
  title: string
  icon?: string
  tabKey: `plugin:${string}`
}

export type PluginListStatus =
  | 'running'
  | 'restarting'
  | 'idle'
  | 'pending'
  | 'disabled'
  | 'errored'
  | 'invalid'

export type PluginListEntry = {
  pluginKey: string
  /** Opaque identity of the exact capabilities and worker tier shown for review. */
  consentFingerprint: string | null
  name: string
  version: string
  publisher: string
  description?: string
  status: PluginListStatus
  needsReconsent: boolean
  error?: string
  isDev: boolean
  official: boolean
  bundled: boolean
  capabilities: { kind: PluginCapabilityKind; description: string }[]
  panels: PluginListPanelEntry[]
  commands: {
    id: string
    title: string
    context: 'global' | 'worktree'
    handler: { type: 'built-in'; action: PluginCommandAliasActionId } | { type: 'worker' }
    keybindings: { key: string; when: 'global' | 'worktree' }[]
  }[]
  hasWorker: boolean
  vmRecipes: {
    id: string
    name: string
    description?: string
    commands: { phase: 'create' | 'suspend' | 'resume' | 'destroy'; command: string }[]
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

export async function buildPluginList(
  service: PluginService,
  lock: PluginLockfile
): Promise<PluginListEntry[]> {
  const consents = {
    pluginConsents: service.options.getPluginConsents(),
    disabledPlugins: service.options.getDisabledPlugins()
  }
  return mapWithConcurrency(
    service.getDiscovered(),
    PLUGIN_LIST_PROJECTION_CONCURRENCY,
    async (plugin, index): Promise<PluginListEntry> => {
      if (isInvalidDiscoveredPlugin(plugin)) {
        // Why: invalid dev paths can contain private absolute desktop paths;
        // never project those as identity over desktop/serve transports.
        const fallbackKey = plugin.pluginKey ?? `invalid-development-plugin-${index + 1}`
        return {
          pluginKey: fallbackKey,
          consentFingerprint: null,
          name: fallbackKey,
          version: '0.0.0',
          publisher: '',
          status: 'invalid' as const,
          needsReconsent: false,
          error: plugin.error,
          isDev: plugin.isDev,
          official: false,
          bundled: false,
          capabilities: [],
          panels: [],
          commands: [],
          hasWorker: false,
          vmRecipes: [],
          restarts: 0
        }
      }
      const activation = service.activationState(plugin)
      const worker = service.workerState(plugin.pluginKey)
      const activationError = service.activationError(plugin.pluginKey)
      const killListEntry = service.options.getPluginKillListEntry?.(plugin.pluginKey) ?? null
      let status: PluginListStatus
      if (activation === 'disabled') {
        status = 'disabled'
      } else if (activation === 'pending') {
        status = 'pending'
      } else if (worker.state === 'errored' || activationError) {
        status = 'errored'
      } else if (worker.state === 'restarting') {
        status = 'restarting'
      } else {
        status = worker.state === 'running' ? 'running' : 'idle'
      }
      const candidateLockEntry = lock.plugins[plugin.pluginKey]
      // Why: never show provenance for bytes other than the current executable
      // identity. Dev overrides execute outside the immutable installed tree and
      // must never inherit the shadowed install's pinned-source attribution.
      const lockEntry =
        candidateLockEntry &&
        !plugin.isDev &&
        plugin.contentHash !== null &&
        candidateLockEntry.contentHash === plugin.contentHash
          ? candidateLockEntry
          : undefined
      const bundled = lockEntry?.source.kind === 'bundled'
      const official =
        bundled ||
        (lockEntry?.source.kind === 'marketplace' &&
          isOfficialPluginIdentity(plugin.pluginKey) &&
          isOfficialMarketplaceGitSource(lockEntry.source.marketplace.url) &&
          isOfficialOrganizationGitSource(lockEntry.source.plugin.url))
      return {
        pluginKey: plugin.pluginKey,
        consentFingerprint: plugin.consentFingerprint,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        publisher: plugin.manifest.publisher,
        ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
        status,
        needsReconsent: needsReconsent(plugin.pluginKey, plugin.consentFingerprint, consents),
        ...(status === 'errored'
          ? { error: activationError ?? 'plugin worker crashed repeatedly' }
          : {}),
        isDev: plugin.isDev,
        official,
        bundled,
        capabilities: plugin.manifest.capabilities.map((capability) => ({
          kind: capability.kind,
          description: PLUGIN_CAPABILITY_DESCRIPTIONS[capability.kind]
        })),
        panels: plugin.manifest.contributes.panels.map((panel) => ({
          id: panel.id,
          title: panel.title,
          ...(panel.icon ? { icon: panel.icon } : {}),
          tabKey: pluginPanelTabKey(plugin.pluginKey, panel.id)
        })),
        commands: service.contentPacks.commands.preview(plugin.pluginKey).map((command) => ({
          id: command.id,
          title: command.title,
          context: command.context,
          handler: command.handler,
          keybindings: command.keybindings
        })),
        hasWorker: Boolean(plugin.manifest.main),
        vmRecipes: service.contentPacks.vmRecipes.preview(plugin.pluginKey).map(({ recipe }) => ({
          id: recipe.id,
          name: recipe.name,
          ...(recipe.description ? { description: recipe.description } : {}),
          commands: listPluginVmRecipeCommands(recipe)
        })),
        restarts: worker.restarts,
        ...(killListEntry
          ? {
              blockedByKillList: {
                reason: killListEntry.reason,
                ...(killListEntry.advisoryUrl ? { advisoryUrl: killListEntry.advisoryUrl } : {})
              }
            }
          : {}),
        ...(lockEntry
          ? {
              source: {
                kind: lockEntry.source.kind,
                reference:
                  lockEntry.source.kind === 'local-path'
                    ? lockEntry.source.path
                    : lockEntry.source.kind === 'git'
                      ? lockEntry.source.url
                      : lockEntry.source.kind === 'marketplace'
                        ? lockEntry.source.plugin.url
                        : `bundled:${lockEntry.source.bundleId}`,
                resolvedCommit: lockEntry.resolvedCommit,
                contentHash: lockEntry.contentHash,
                ...(lockEntry.source.kind === 'marketplace'
                  ? {
                      marketplace: {
                        reference: lockEntry.source.marketplace.url,
                        resolvedCommit: lockEntry.source.marketplace.resolvedCommit
                      }
                    }
                  : {})
              }
            }
          : {})
      }
    }
  )
}
