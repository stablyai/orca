import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import type { ForgeProvider } from '../source-control/forge-provider'

/**
 * A resolved forge provider contribution from a plugin.
 * The module has been loaded and its exports validated.
 */
export type ResolvedPluginForgeProvider = {
  pluginKey: string
  contributionId: string
  id: string
  displayName: string
  hosts: string[]
  provider: ForgeProvider
}

export class PluginForgeProviderRegistry {
  private active: ResolvedPluginForgeProvider[] = []
  private readonly loadErrors = new Map<string, string>()
  /** Resolved providers pending approval (available for preview via IPC). */
  private previews: ResolvedPluginForgeProvider[] = []

  list(): readonly ResolvedPluginForgeProvider[] {
    return this.active
  }

  preview(): readonly ResolvedPluginForgeProvider[] {
    return this.previews
  }

  error(pluginKey: string): string | null {
    return this.loadErrors.get(pluginKey) ?? null
  }

  /**
   * Reconcile plugin forge providers from discovered plugins.
   * Loads modules for approved plugins; stores previews for all.
   */
  async reconcile(
    discovered: readonly DiscoveredPlugin[],
    isApproved: (plugin: ValidDiscoveredPlugin) => boolean
  ): Promise<void> {
    const candidates = discovered.filter(
      (plugin): plugin is ValidDiscoveredPlugin =>
        !isInvalidDiscoveredPlugin(plugin) && plugin.manifest.contributes.forgeProviders.length > 0
    )
    const resolved: ResolvedPluginForgeProvider[] = []
    this.loadErrors.clear()

    // First pass: validate ownership - no duplicate contribution ids across plugins
    const seenIds = new Map<string, string>() // contributionId → pluginKey
    for (const plugin of candidates) {
      for (const contrib of plugin.manifest.contributes.forgeProviders) {
        const existing = seenIds.get(contrib.id)
        if (existing && existing !== plugin.pluginKey) {
          this.loadErrors.set(
            plugin.pluginKey,
            `forge provider id "${contrib.id}" is already claimed by plugin "${existing}"`
          )
        }
        seenIds.set(contrib.id, plugin.pluginKey)
      }
    }

    // Second pass: load modules for approved plugins
    for (const plugin of candidates) {
      if (!isApproved(plugin) || this.loadErrors.has(plugin.pluginKey)) {
        // Store previews for all candidates (for UI / settings)
        continue
      }
      for (const contrib of plugin.manifest.contributes.forgeProviders) {
        try {
          const module = await loadPluginForgeProviderModule(plugin.rootDir, contrib.modulePath)
          validateForgeProviderModule(module, contrib.id)
          // Build the provider id as <contribution-id> — unique across builtins and plugins
          const providerId = contrib.id
          const provider: ForgeProvider & { displayName: string } = {
            id: providerId,
            displayName: contrib.displayName,
            supportsReviewCreation: contrib.supportsReviewCreation,
            // copy is optional; plugin can provide it
            ...(module.copy !== undefined ? { copy: module.copy } : {}),
            resolveRepository: module.resolveRepository,
            ...(module.isAuthenticated !== undefined
              ? { isAuthenticated: module.isAuthenticated }
              : {}),
            getReviewForBranch: module.getReviewForBranch,
            getReviewByNumber: module.getReviewByNumber,
            ...(module.createReview !== undefined ? { createReview: module.createReview } : {})
          }
          resolved.push({
            pluginKey: plugin.pluginKey,
            contributionId: contrib.id,
            id: providerId,
            displayName: contrib.displayName,
            hosts: contrib.hosts,
            provider
          })
        } catch (error) {
          this.loadErrors.set(
            plugin.pluginKey,
            `failed to load forge provider "${contrib.id}": ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }

    this.previews = candidates.flatMap((plugin) =>
      plugin.manifest.contributes.forgeProviders.map(
        (contrib): ResolvedPluginForgeProvider => ({
          pluginKey: plugin.pluginKey,
          contributionId: contrib.id,
          id: contrib.id,
          displayName: contrib.displayName,
          hosts: contrib.hosts,
          provider: null as unknown as ForgeProvider // not loaded yet
        })
      )
    )
    this.active = resolved
  }

  /**
   * Find a plugin forge provider by matching host against a remote URL host.
   * First matches by `hosts` array (exact host match, optionally with port).
   */
  findByHost(host: string): ResolvedPluginForgeProvider | null {
    const normalizedHost = host.toLowerCase()
    for (const entry of this.active) {
      if (entry.hosts.some((h) => h.toLowerCase() === normalizedHost)) {
        return entry
      }
    }
    return null
  }

  getByProviderId(providerId: string): ForgeProvider | null {
    const entry = this.active.find((e) => e.id === providerId)
    return entry?.provider ?? null
  }

  clearPlugin(pluginKey: string): void {
    this.active = this.active.filter((e) => e.pluginKey !== pluginKey)
    this.previews = this.previews.filter((e) => e.pluginKey !== pluginKey)
    this.loadErrors.delete(pluginKey)
  }
}

/**
 * Load a plugin forge provider module from disk using dynamic import().
 * The module file path is relative to the plugin root directory.
 */
async function loadPluginForgeProviderModule(
  pluginRoot: string,
  modulePath: string
): Promise<Record<string, unknown>> {
  const absolutePath = join(pluginRoot, ...modulePath.split(/[\\/]/))
  const entryUrl = pathToFileURL(absolutePath).href
  const mod: Record<string, unknown> = await import(entryUrl)
  // CJS interop: Node may expose module.exports as `default` only
  if (
    typeof mod.default === 'object' &&
    mod.default !== null &&
    Object.keys(mod).length <= 2 &&
    'resolveRepository' in mod.default
  ) {
    return mod.default as Record<string, unknown>
  }
  return mod
}

/** Structural shape of a validated plugin forge provider module export. */
type LoadedForgeProviderModule = {
  resolveRepository: ForgeProvider['resolveRepository']
  getReviewForBranch: ForgeProvider['getReviewForBranch']
  getReviewByNumber: ForgeProvider['getReviewByNumber']
  copy?: ForgeProvider['copy']
  isAuthenticated?: ForgeProvider['isAuthenticated']
  createReview?: ForgeProvider['createReview']
}

/**
 * Validate that a loaded module exports the required ForgeProvider fields.
 */
function validateForgeProviderModule(
  mod: Record<string, unknown>,
  contributionId: string
): asserts mod is LoadedForgeProviderModule {
  const required = ['resolveRepository', 'getReviewForBranch', 'getReviewByNumber']
  const missing = required.filter((key) => typeof mod[key] !== 'function')
  if (missing.length > 0) {
    throw new Error(
      `forge provider "${contributionId}" module is missing required exports: ${missing.join(', ')}`
    )
  }
}
