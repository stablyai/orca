import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PLUGIN_CONTENT_HASH_PATTERN,
  pluginLockEntrySchema,
  type PluginLockEntry,
  type PluginLockfile
} from '../../shared/plugins/plugin-install-lockfile'
import { isQualifiedPluginKey } from '../../shared/plugins/plugin-manifest'
import { writePluginFileAtomically } from './plugin-atomic-file-write'
import { readPluginCurrentPointer } from './plugin-current-pointer'

const PROVENANCE_DIRECTORY = '.install-provenance'
const PROVENANCE_MAX_BYTES = 64 * 1024

function provenancePath(pluginDir: string, contentHash: string): string {
  if (!PLUGIN_CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new Error('invalid plugin content hash')
  }
  return join(pluginDir, PROVENANCE_DIRECTORY, `${contentHash}.json`)
}

/** Prewrites immutable provenance before the executable current pointer moves. */
export async function writePluginInstallProvenance(
  pluginDir: string,
  entry: PluginLockEntry
): Promise<void> {
  const parsedEntry = pluginLockEntrySchema.parse(entry)
  const directory = join(pluginDir, PROVENANCE_DIRECTORY)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writePluginFileAtomically(
    provenancePath(pluginDir, parsedEntry.contentHash),
    JSON.stringify({ version: 1, entry: parsedEntry }, null, 2),
    { mode: 0o600 }
  )
}

export async function readPluginInstallProvenance(
  pluginDir: string,
  contentHash: string
): Promise<PluginLockEntry | null> {
  try {
    const chunks: Buffer[] = []
    let totalBytes = 0
    for await (const chunk of createReadStream(provenancePath(pluginDir, contentHash))) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += bytes.byteLength
      if (totalBytes > PROVENANCE_MAX_BYTES) {
        return null
      }
      chunks.push(bytes)
    }
    const raw = JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8')) as {
      version?: unknown
      entry?: unknown
    }
    if (raw.version !== 1) {
      return null
    }
    const parsed = pluginLockEntrySchema.safeParse(raw.entry)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Repairs a pointer-new/lock-old interrupted publication from immutable provenance. */
export async function recoverPluginLockfile(
  pluginsDir: string,
  lock: PluginLockfile
): Promise<{ lock: PluginLockfile; changed: boolean }> {
  const plugins = { ...lock.plugins }
  let changed = false
  const directories = await readdir(pluginsDir, { withFileTypes: true }).catch(() => [])
  for (const directory of directories) {
    if (!directory.isDirectory() || !isQualifiedPluginKey(directory.name)) {
      continue
    }
    const pluginDir = join(pluginsDir, directory.name)
    const contentHash = await readPluginCurrentPointer(pluginDir).catch(() => null)
    if (!contentHash || !PLUGIN_CONTENT_HASH_PATTERN.test(contentHash)) {
      continue
    }
    const provenance = await readPluginInstallProvenance(pluginDir, contentHash)
    if (
      !provenance ||
      provenance.pluginKey !== directory.name ||
      provenance.contentHash !== contentHash
    ) {
      continue
    }
    if (JSON.stringify(plugins[directory.name]) !== JSON.stringify(provenance)) {
      plugins[directory.name] = provenance
      changed = true
    }
  }
  return { lock: { version: 1, plugins }, changed }
}

export async function prunePluginInstallProvenance(
  pluginDir: string,
  retained: ReadonlySet<string>
): Promise<void> {
  const directory = join(pluginDir, PROVENANCE_DIRECTORY)
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.json') &&
          PLUGIN_CONTENT_HASH_PATTERN.test(entry.name.slice(0, -'.json'.length)) &&
          !retained.has(entry.name.slice(0, -'.json'.length))
      )
      .map((entry) => rm(join(directory, entry.name), { force: true }))
  )
}
