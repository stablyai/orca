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
  hasInstructionalPluginContributions
} from '../../shared/plugins/plugin-consent-fingerprint'
import { validateDeclaredPluginArtifacts } from './plugin-artifact-validation'
import { readPluginManifestText } from './plugin-manifest-file'
import { readPluginCurrentPointer } from './plugin-current-pointer'
import { hashPluginTree } from './plugin-content-hash'

export { PLUGIN_CURRENT_POINTER_FILENAME } from './plugin-current-pointer'

const INSTALLED_PLUGIN_DISCOVERY_CONCURRENCY = 8

/**
 * Discovery over the hash-addressed install layout:
 *
 *   <userData>/plugins/<publisher>.<id>/current   ← text file naming the hash
 *   <userData>/plugins/<publisher>.<id>/<hash>/   ← immutable install tree
 *
 * plus dev-mode plugins loaded straight from arbitrary local directories.
 * Discovery reads manifests and checks only their declared artifact paths —
 * never plugin bytes or whole trees. Full content hashing stays lazy so
 * startup cost is bounded by installed plugins plus declared entries.
 */

export type ValidDiscoveredPlugin = {
  /** Qualified `<publisher>.<id>` key. */
  pluginKey: string
  rootDir: string
  manifest: PluginManifest
  /** Fingerprint of the capabilities and trusted-worker execution tier. */
  consentFingerprint: string
  /** Immutable tree identity included in consent for instructional packs. */
  consentContentHash?: string | null
  /** Content hash the install dir is named by; null for dev plugins. */
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
  if (installedContentHash && hasInstructionalPluginContributions(manifest)) {
    consentContentIdentity = installedContentHash
  }
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
  // The pointer names a sibling directory; refuse anything path-like so a
  // corrupted pointer cannot address content outside the plugin dir.
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
  // Why: the directory name is the install key (and the uninstall target); a
  // mismatched manifest identity would let two dirs claim the same plugin.
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
  // Installed manifests are independent immutable trees. Read them in
  // a bounded pool so startup latency stays low without exhausting handles.
  discovered.push(
    ...(await readInstalledPlugins(options.pluginsDir, installedEntries, options.hostVersion))
  )
  for (const devPath of options.devPluginPaths) {
    const plugin = await readManifestDir(devPath, options.hostVersion, true)
    // A dev path that duplicates an installed plugin's identity wins — that
    // is the point of dev mode — but two dev paths must not collide.
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
