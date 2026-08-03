import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PLUGIN_CONTENT_HASH_PATTERN,
  upsertPluginLock,
  type PluginLockEntry
} from '../../shared/plugins/plugin-install-lockfile'
import {
  readPluginCurrentPointer,
  restorePluginCurrentPointer,
  writePluginCurrentPointer
} from './plugin-current-pointer'
import { readPluginLockfile, writePluginLockfile } from './plugin-install-lockfile-store'
import {
  prunePluginInstallProvenance,
  readPluginInstallProvenance,
  writePluginInstallProvenance
} from './plugin-install-provenance'

/** Publishes executable identity and provenance as one recoverable mutation,
 * then retains only current plus one rollback version. */
export async function publishPluginInstall(input: {
  pluginsDir: string
  pluginDir: string
  entry: PluginLockEntry
}): Promise<void> {
  const previousContentHash = await readPluginCurrentPointer(input.pluginDir)
  const currentLock = await readPluginLockfile(input.pluginsDir)
  const provenanceCandidate =
    previousContentHash === input.entry.contentHash
      ? await readPluginInstallProvenance(input.pluginDir, input.entry.contentHash)
      : null
  const matchesCurrentIdentity = (entry: PluginLockEntry | undefined | null): boolean =>
    entry?.pluginKey === input.entry.pluginKey && entry.contentHash === input.entry.contentHash
  const existingProvenance = matchesCurrentIdentity(provenanceCandidate)
    ? provenanceCandidate
    : null
  const legacyLockEntry = currentLock.plugins[input.entry.pluginKey]
  const legacyCurrentEntry =
    previousContentHash === input.entry.contentHash && matchesCurrentIdentity(legacyLockEntry)
      ? legacyLockEntry
      : null
  // Provenance is immutable per executable identity. A same-byte reinstall
  // is a no-op so a failed or interrupted source change cannot be recovered
  // later as though it had successfully published.
  const publishedEntry = existingProvenance ?? legacyCurrentEntry ?? input.entry
  const nextLock = upsertPluginLock(currentLock, publishedEntry)
  // Why: after a crash between pointer and global-index publication, startup
  // can reconstruct exact source/commit identity from this immutable record.
  if (!existingProvenance) {
    await writePluginInstallProvenance(input.pluginDir, publishedEntry)
  }
  await writePluginCurrentPointer(input.pluginDir, input.entry.contentHash)
  try {
    await writePluginLockfile(input.pluginsDir, nextLock)
  } catch (publicationError) {
    try {
      await restorePluginCurrentPointer(input.pluginDir, previousContentHash)
    } catch (rollbackError) {
      throw new AggregateError(
        [publicationError, rollbackError],
        'plugin install publication and pointer rollback both failed'
      )
    }
    throw publicationError
  }
  // Reinstalling B must not collapse an existing A rollback into {B}.
  if (previousContentHash !== input.entry.contentHash) {
    await pruneHistoricalVersions(
      input.pluginDir,
      new Set(
        [input.entry.contentHash, previousContentHash].filter(
          (hash): hash is string =>
            typeof hash === 'string' && PLUGIN_CONTENT_HASH_PATTERN.test(hash)
        )
      )
    ).catch(() => undefined)
  }
}

async function pruneHistoricalVersions(pluginDir: string, retained: ReadonlySet<string>) {
  const entries = await readdir(pluginDir, { withFileTypes: true })
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          PLUGIN_CONTENT_HASH_PATTERN.test(entry.name) &&
          !retained.has(entry.name)
      )
      .map((entry) => rm(join(pluginDir, entry.name), { recursive: true, force: true }))
  )
  await prunePluginInstallProvenance(pluginDir, retained)
}
