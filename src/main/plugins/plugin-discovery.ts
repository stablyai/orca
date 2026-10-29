import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_CONTENT_HASH_PATTERN } from '../../shared/plugins/plugin-install-lockfile'
import {
  PLUGIN_MANIFEST_FILENAME,
  isQualifiedPluginKey,
  parsePluginManifest,
  qualifiedPluginKey,
  satisfiesOrcaEngineRange,
  type PluginManifest
} from '../../shared/plugins/plugin-manifest'
import {
  fingerprintPluginConsent,
  hasInstructionalPluginContributions,
  requiresPluginContentApproval
} from '../../shared/plugins/plugin-consent-fingerprint'
import { validateDeclaredPluginArtifacts } from './plugin-artifact-validation'
import { readPluginManifestText } from './plugin-manifest-file'
import { readPluginCurrentPointer } from './plugin-current-pointer'
import { hashPluginTree } from './plugin-content-hash'

export { PLUGIN_CURRENT_POINTER_FILENAME } from './plugin-current-pointer'

const INSTALLED_PLUGIN_DISCOVERY_CONCURRENCY = 8

// Discovery reads manifests/declared paths only; immutable tree hashing stays lazy to bound startup cost.

export type ValidDiscoveredPlugin = {
  pluginKey: string
  rootDir: string
  manifest: PluginManifest
  /** Fingerprint of the capabilities and trusted-worker execution tier. */
  consentFingerprint: string
  /** Immutable tree identity included in consent for instructional packs. */
  consentContentHash?: string | null
  /** Null for mutable dev trees. */
  contentHash: string | null
  isDev: boolean
}

export type InvalidDiscoveredPlugin = {
  pluginKey?: string
  rootDir: string
  error: string
  isDev: boolean
}

export type DiscoveredPlugin = ValidDiscoveredPlugin | InvalidDiscoveredPlugin

export function isInvalidDiscoveredPlugin(
  plugin: DiscoveredPlugin
): plugin is InvalidDiscoveredPlugin {
  return 'error' in plugin
}

export function getUserPluginsDir(userDataPath: string): string {
  return join(userDataPath, 'plugins')
}

export function getPluginsDataDir(userDataPath: string): string {
  return join(userDataPath, 'plugins-data')
}

async function readManifestDir(
  rootDir: string,
  hostVersion: string,
  isDev: boolean,
  installedContentHash?: string
): Promise<DiscoveredPlugin> {
  let rawText: string
  try {
    rawText = await readPluginManifestText(rootDir)
  } catch (error) {
    return {
      rootDir,
      error:
        error instanceof Error && error.message.includes('exceeds')
          ? error.message
          : `missing ${PLUGIN_MANIFEST_FILENAME}`,
      isDev
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(rawText)
  } catch (error) {
    return {
      rootDir,
      error: `invalid JSON in ${PLUGIN_MANIFEST_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
      isDev
    }
  }
  const parsed = parsePluginManifest(raw)
  if (!parsed.ok) {
    return { rootDir, error: `invalid manifest: ${parsed.error}`, isDev }
  }
  const manifest = parsed.manifest
  const pluginKey = qualifiedPluginKey(manifest)
  if (!satisfiesOrcaEngineRange(hostVersion, manifest.engines.orca)) {
    return {
      pluginKey,
      rootDir,
      error: `requires Orca ${manifest.engines.orca} (this is ${hostVersion})`,
      isDev
    }
  }
  const artifacts = await validateDeclaredPluginArtifacts(rootDir, manifest)
  if (!artifacts.ok) {
    return {
      pluginKey,
      rootDir,
      error: `invalid declared artifact: ${artifacts.error}`,
      isDev
    }
  }
  let consentContentIdentity: string | undefined
  if (installedContentHash && requiresPluginContentApproval(manifest)) {
    consentContentIdentity = installedContentHash
  }
  // Why dev trees bind only instructions: dev code is the author's working copy, and
  // binding it would re-prompt on every save.
  if (isDev && hasInstructionalPluginContributions(manifest)) {
    const treeHash = await hashPluginTree(rootDir)
    if (!treeHash.ok) {
      return { pluginKey, rootDir, error: treeHash.error, isDev }
    }
    consentContentIdentity = treeHash.hash
  }
  return {
    pluginKey,
    rootDir,
    manifest,
    consentFingerprint: fingerprintPluginConsent(manifest, consentContentIdentity),
    consentContentHash: consentContentIdentity ?? null,
    contentHash: null,
    isDev
  }
}

async function readInstalledPlugin(
  pluginDir: string,
  dirName: string,
  hostVersion: string
): Promise<DiscoveredPlugin> {
  let contentHash: string
  try {
    contentHash = (await readPluginCurrentPointer(pluginDir)) ?? ''
  } catch {
    return {
      pluginKey: dirName,
      rootDir: pluginDir,
      error: 'missing current-version pointer',
      isDev: false
    }
  }
  // Pointers may name only sibling hash directories; reject paths escaping the plugin root.
  if (!PLUGIN_CONTENT_HASH_PATTERN.test(contentHash)) {
    return {
      pluginKey: dirName,
      rootDir: pluginDir,
      error: 'corrupt current-version pointer',
      isDev: false
    }
  }
  const versionDir = join(pluginDir, contentHash)
  const discovered = await readManifestDir(versionDir, hostVersion, false, contentHash)
  if (isInvalidDiscoveredPlugin(discovered)) {
    return { ...discovered, pluginKey: dirName }
  }
  // Install directory names own uninstall identity; mismatched manifests could duplicate ownership.
  if (discovered.pluginKey !== dirName) {
    return {
      pluginKey: dirName,
      rootDir: versionDir,
      error: `manifest identity "${discovered.pluginKey}" does not match install directory "${dirName}"`,
      isDev: false
    }
  }
  return { ...discovered, contentHash }
}

async function readInstalledPlugins(
  pluginsDir: string,
  entries: readonly Dirent[],
  hostVersion: string
): Promise<DiscoveredPlugin[]> {
  const results = Array.from({ length: entries.length }) as DiscoveredPlugin[]
  let nextIndex = 0
  const readers = Array.from(
    { length: Math.min(INSTALLED_PLUGIN_DISCOVERY_CONCURRENCY, entries.length) },
    async () => {
      while (nextIndex < entries.length) {
        const index = nextIndex++
        const entry = entries[index]!
        results[index] = await readInstalledPlugin(
          join(pluginsDir, entry.name),
          entry.name,
          hostVersion
        )
      }
    }
  )
  await Promise.all(readers)
  return results
}

export async function discoverPlugins(options: {
  pluginsDir: string
  devPluginPaths: readonly string[]
  hostVersion: string
}): Promise<DiscoveredPlugin[]> {
  const discovered: DiscoveredPlugin[] = []
  let entries: Dirent[] = []
  try {
    entries = await readdir(options.pluginsDir, { withFileTypes: true })
  } catch {
    // A missing plugins dir just means no plugins are installed yet.
  }
  const installedEntries = entries.filter(
    (entry) => entry.isDirectory() && isQualifiedPluginKey(entry.name)
  )
  // Bound parallel immutable-manifest reads to avoid exhausting file handles.
  discovered.push(
    ...(await readInstalledPlugins(options.pluginsDir, installedEntries, options.hostVersion))
  )
  for (const devPath of options.devPluginPaths) {
    const plugin = await readManifestDir(devPath, options.hostVersion, true)
    // Dev paths override installed identities; two dev paths still cannot claim one identity.
    if (!isInvalidDiscoveredPlugin(plugin)) {
      const collision = discovered.find(
        (existing) =>
          !isInvalidDiscoveredPlugin(existing) && existing.pluginKey === plugin.pluginKey
      )
      if (collision) {
        discovered.splice(discovered.indexOf(collision), 1)
      }
    }
    discovered.push(plugin)
  }
  return discovered
}
