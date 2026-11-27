import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { lastAntigravityChatRunsInOrcaHome } from '../../antigravity/antigravity-chat-route'
import { mapWithConcurrency } from '../../../shared/concurrency/map-with-concurrency'
import {
  asRecord,
  parseJsoncObject
} from '../../../shared/workspace-setup/setup-script-import-parsers'
import { stablePathId } from './skill-discovery-classification'
import type { SkillScanRoot } from './skill-discovery-sources'
import { readPluginMetadataFile, safePluginLabel } from './plugin-skill-metadata'

// Manifests are parsed synchronously as their reads land. Every read in flight can land in one
// event-loop turn, so at most MANIFEST_READ_CONCURRENCY parses share a turn (about 3 ms at the
// worst nesting), and the caps bound the whole scan to 64 parses of 4 KiB. Real manifests are
// about 1 KB.
const MAX_ANTIGRAVITY_PLUGINS = 64
const MAX_MANIFEST_BYTES = 4 * 1024
const MANIFEST_READ_CONCURRENCY = 8
const MAX_CONFIG_BYTES = 64 * 1024
// agy's manifest locations in precedence order; a folder without one is not a plugin.
const MANIFEST_PATHS: readonly (readonly string[])[] = [
  ['.antigravity-plugin', 'plugin.json'],
  ['.gemini-plugin', 'plugin.json'],
  ['plugin.json']
]

// agy loads only the first manifest that exists, and skips the plugin when that one is not a
// JSON object or has a non-boolean `disabled`.
async function readManifest(
  pluginPath: string,
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  // One listing spares the usual root-manifest plugin two failed lookups.
  const entries = new Set(await readdir(pluginPath).catch((): string[] => []))
  for (const segments of MANIFEST_PATHS) {
    const manifestPath = join(pluginPath, ...segments)
    const exists =
      entries.has(segments[0]) &&
      (segments.length === 1 ||
        (await stat(manifestPath).then(
          () => true,
          () => false
        )))
    signal?.throwIfAborted()
    if (!exists) {
      continue
    }
    // agy parses its JSON files as JSONC and accepts a leading byte order mark.
    const manifest = parseJsoncObject(
      await readPluginMetadataFile(manifestPath, signal, MAX_MANIFEST_BYTES)
    )
    return manifest && typeof (manifest.disabled ?? false) === 'boolean' ? manifest : null
  }
  return null
}

function configuredEnablement(config: string | null): Map<string, boolean> {
  const plugins = asRecord(parseJsoncObject(config)?.plugins)
  const enabled = new Map<string, boolean>()
  for (const [folder, entry] of Object.entries(plugins ?? {})) {
    const enabledInConfig = asRecord(entry)?.enabled
    if (typeof enabledInConfig === 'boolean') {
      enabled.set(folder, enabledInConfig)
    }
  }
  return enabled
}

/** Skill roots of the plugins agy loads from `~/.gemini/config/plugins`: `config.json`'s
 *  `plugins.<folder>.enabled` wins, else the manifest's `"disabled": true` keeps one off. */
export async function discoverAntigravityPluginSkillSources(args: {
  homeDir: string
  signal?: AbortSignal
}): Promise<SkillScanRoot[]> {
  if (lastAntigravityChatRunsInOrcaHome()) {
    return []
  }
  const configRoot = join(args.homeDir, '.gemini', 'config')
  const pluginsRoot = join(configRoot, 'plugins')
  const folders = (await readdir(pluginsRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort()
    .slice(0, MAX_ANTIGRAVITY_PLUGINS)
  args.signal?.throwIfAborted()
  if (folders.length === 0) {
    return []
  }
  const configured = configuredEnablement(
    await readPluginMetadataFile(join(configRoot, 'config.json'), args.signal, MAX_CONFIG_BYTES)
  )
  const roots = await mapWithConcurrency(
    folders,
    MANIFEST_READ_CONCURRENCY,
    async (folder): Promise<SkillScanRoot | null> => {
      const enabledInConfig = configured.get(folder)
      if (enabledInConfig === false) {
        return null
      }
      const pluginPath = join(pluginsRoot, folder)
      const manifest = await readManifest(pluginPath, args.signal)
      if (!manifest || (manifest.disabled === true && !enabledInConfig)) {
        return null
      }
      const skillsPath = join(pluginPath, 'skills')
      return {
        id: `antigravity-plugin-${stablePathId(skillsPath)}`,
        label: `Antigravity plugin ${safePluginLabel(folder)}`,
        path: skillsPath,
        sourceKind: 'plugin',
        providers: ['agent-skills'],
        owner: 'antigravity'
      }
    }
  )
  return roots.filter((root): root is SkillScanRoot => root !== null)
}
