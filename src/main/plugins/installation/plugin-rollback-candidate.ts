import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePluginManifest } from '../../../shared/plugins/manifest/plugin-manifest'
import { readPluginCurrentPointer } from './plugin-current-pointer'
import { readPluginManifestText } from '../plugin-manifest-file'
import { PLUGIN_CONTENT_HASH_PATTERN } from '../../../shared/plugins/plugin-install-lockfile'

export type PluginRollbackCandidate =
  | { ok: true; currentContentHash: string; contentHash: string }
  | { ok: false; error: string }

/** The one retained version besides the current one; anything else is not a safe rollback. */
export async function findPluginRollbackCandidate(
  pluginDir: string
): Promise<PluginRollbackCandidate> {
  const currentContentHash = await readPluginCurrentPointer(pluginDir).catch(() => null)
  if (!currentContentHash) {
    return { ok: false, error: 'installed plugin has no current version' }
  }
  const candidates = (await readdir(pluginDir, { withFileTypes: true }).catch(() => []))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        PLUGIN_CONTENT_HASH_PATTERN.test(entry.name) &&
        entry.name !== currentContentHash
    )
    .map((entry) => entry.name)
  const [contentHash] = candidates
  if (candidates.length !== 1 || !contentHash) {
    return {
      ok: false,
      error:
        candidates.length === 0 ? 'no rollback version is available' : 'rollback state is ambiguous'
    }
  }
  return { ok: true, currentContentHash, contentHash }
}

/** Version a rollback would restore, for "Roll back to X"; null when none is safe to offer. */
export async function readPluginRollbackVersion(pluginDir: string): Promise<string | null> {
  const candidate = await findPluginRollbackCandidate(pluginDir)
  if (!candidate.ok) {
    return null
  }
  try {
    const parsed = parsePluginManifest(
      JSON.parse(await readPluginManifestText(join(pluginDir, candidate.contentHash)))
    )
    return parsed.ok ? parsed.manifest.version : null
  } catch {
    return null
  }
}
