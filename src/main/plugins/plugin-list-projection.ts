import { PLUGIN_CAPABILITY_DESCRIPTIONS } from '../../shared/plugins/capabilities/plugin-capabilities'
import { needsReconsent } from '../../shared/plugins/approval/plugin-consent-state'
import { pluginPanelTabKey } from '../../shared/plugins/manifest/plugin-manifest'
import type { PluginLockfile } from '../../shared/plugins/installation/plugin-install-lockfile'
import { isInvalidDiscoveredPlugin, type DiscoveredPlugin } from './plugin-discovery'
import {
  pluginInstalledImageUrl,
  type PluginHostImages
} from '../../shared/plugins/images/plugin-image-url'
import { pluginInstalledHostImages } from './plugin-manifest-images'
import type { PluginService } from './plugin-service'
import { listPluginVmRecipeCommands } from '../../shared/plugins/artifacts/plugin-vm-recipe-artifact'
import {
  isOfficialMarketplaceGitSource,
  isOfficialOrganizationGitSource,
  pluginSourceLabel
} from '../../shared/plugins/catalog/plugin-marketplace'
import { pluginCatalogTypes } from '../../shared/plugins/catalog/plugin-catalog-types'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import type { PluginHostListEntry, PluginHostStatus } from '../../shared/plugins/plugin-list-entry'
import { customEditorContentKind } from '../../shared/plugins/contributions/plugin-custom-editor-contribution'
import { pluginExecutionProfile } from '../../shared/plugins/contributions/plugin-execution-profile'

const PLUGIN_LIST_PROJECTION_CONCURRENCY = 4

type PluginLockEntry = PluginLockfile['plugins'][string]

function lockEntrySource(
  lockEntry: PluginLockEntry | undefined
): Pick<PluginHostListEntry, 'source'> {
  if (!lockEntry) {
    return {}
  }
  return {
    source: {
      kind: lockEntry.source.kind,
      reference:
        lockEntry.source.kind === 'local-path'
          ? lockEntry.source.path
          : lockEntry.source.kind === 'git'
            ? lockEntry.source.url
            : lockEntry.source.kind === 'marketplace'
              ? pluginSourceLabel(lockEntry.source.plugin)
              : `bundled:${lockEntry.source.bundleId}`,
      resolvedCommit: lockEntry.resolvedCommit,
      contentHash: lockEntry.contentHash,
      ...(lockEntry.source.kind === 'marketplace'
        ? {
            marketplace: {
              reference: lockEntry.source.marketplace.url,
              ref: lockEntry.source.marketplace.ref,
              resolvedCommit: lockEntry.source.marketplace.resolvedCommit
            }
          }
        : {})
    }
  }
}

const withImages = (images: PluginHostImages | undefined) => (images ? { images } : {})

export async function buildPluginList(
  service: PluginService,
  lock: PluginLockfile,
  discovered: readonly DiscoveredPlugin[] = service.getDiscovered()
): Promise<PluginHostListEntry[]> {
  const consents = {
    pluginConsents: service.options.getPluginConsents(),
    disabledPlugins: service.options.getDisabledPlugins()
  }
  return mapWithConcurrency(
    discovered,
    PLUGIN_LIST_PROJECTION_CONCURRENCY,
    async (plugin, index): Promise<PluginHostListEntry> => {
      if (isInvalidDiscoveredPlugin(plugin)) {
        // Invalid dev paths may expose private absolute paths; use opaque identities for clients.
        const fallbackKey = plugin.pluginKey ?? `invalid-development-plugin-${index + 1}`
        // Why the lock entry: it says which catalog installed it, so the list can offer an update.
        const lockEntry =
          !plugin.isDev && plugin.pluginKey ? lock.plugins[plugin.pluginKey] : undefined
        return {
          pluginKey: fallbackKey,
          consentFingerprint: null,
          name: fallbackKey,
          version: lockEntry?.version ?? '0.0.0',
          publisher: '',
          status: 'invalid' as const,
          needsReconsent: false,
          error: plugin.error,
          isDev: plugin.isDev,
          official: false,
          bundled: false,
          capabilities: [],
          panels: [],
          customEditors: [],
          newFiles: [],
          commands: [],
          hasWorker: false,
          vmRecipes: [],
          restarts: 0,
          ...lockEntrySource(lockEntry)
        }
      }
      const activation = service.activationState(plugin)
      const worker = service.workerState(plugin.pluginKey)
      const activationError = service.activationError(plugin.pluginKey)
      const killListEntry = service.options.getPluginKillListEntry?.(plugin.pluginKey) ?? null
      let status: PluginHostStatus
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
      // Show provenance only for current immutable bytes; dev overrides cannot inherit installed attribution.
      const lockEntry =
        candidateLockEntry &&
        !plugin.isDev &&
        plugin.contentHash !== null &&
        candidateLockEntry.contentHash === plugin.contentHash
          ? candidateLockEntry
          : undefined
      // Why format 2 only: the image protocol serves no format 1 image, so a URL would 404.
      const contributionIcon = (slot: string, path: string | undefined) =>
        path !== undefined && plugin.manifest.manifestVersion === 2
          ? { icon: pluginInstalledImageUrl(plugin.pluginKey, plugin.contentHash ?? 'dev', slot) }
          : {}
      const bundled = lockEntry?.source.kind === 'bundled'
      const official =
        bundled ||
        (lockEntry?.source.kind === 'marketplace' &&
          isOfficialMarketplaceGitSource(lockEntry.source.marketplace.url) &&
          isOfficialOrganizationGitSource(lockEntry.source.plugin.url))
      return {
        pluginKey: plugin.pluginKey,
        consentFingerprint: plugin.consentFingerprint,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        publisher: plugin.manifest.publisher,
        ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
        execution: pluginExecutionProfile(plugin.manifest),
        types: pluginCatalogTypes(plugin.manifest),
        ...withImages(
          pluginInstalledHostImages(plugin.pluginKey, plugin.contentHash, plugin.manifest)
        ),
        ...(plugin.manifest.license ? { license: plugin.manifest.license } : {}),
        ...(plugin.manifest.homepage ? { homepage: plugin.manifest.homepage } : {}),
        ...(plugin.manifest.repository ? { repository: plugin.manifest.repository } : {}),
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
        customEditors: plugin.manifest.contributes.customEditors.map((editor, index) => ({
          id: editor.id,
          title: editor.title,
          extensions: editor.extensions,
          filenames: editor.filenames,
          priority: editor.priority ?? 'default',
          contentKind: customEditorContentKind(editor),
          ...contributionIcon(`editor-${index}`, editor.icon)
        })),
        newFiles: plugin.manifest.contributes.newFiles.map((newFile, index) => ({
          id: newFile.id,
          title: newFile.title,
          extension: newFile.extension,
          ...contributionIcon(`new-file-${index}`, newFile.icon)
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
        ...lockEntrySource(lockEntry)
      }
    }
  )
}
