import { tmpdir } from 'node:os'
import {
  PLUGIN_MARKETPLACE_FILENAME,
  pluginMarketplaceSchema,
  type PluginMarketplace
} from '../../../shared/plugins/catalog/plugin-marketplace'
import {
  PLUGIN_CATALOG_FILENAME,
  pluginCatalogSchema,
  pluginCatalogVersionError
} from '../../../shared/plugins/catalog/plugin-catalog'
import { formatPluginSchemaIssues } from '../../../shared/plugins/manifest/plugin-schema-issues'
import { gitExecFileAsyncBuffer } from '../../git/command-runner/git-exec-file'
import { extractCatalogImages, type CatalogBlobReader } from './plugin-catalog-image-extraction'
import { fillMonorepoReleaseImages } from './plugin-catalog-monorepo-images'
import { readPluginGitCommit } from '../installation/plugin-git-repository'
import { readPluginGitBatchBlobs, type PluginGitTreeEntry } from '../installation/plugin-git-tree'
import type { PluginMarketplaceRegisteredSource } from './plugin-marketplace-store'

const MARKETPLACE_INDEX_MAX_BYTES = 16 * 1024 * 1024
// Why its own cap: a catalog repository may hold far more than one plugin, and only its index is read.
const MARKETPLACE_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024
const MARKETPLACE_GIT_TIMEOUT_MS = 120_000
// Extraction's 64 MiB image budget plus one round of reads that budget later refuses; past it, read sequentially.
const CATALOG_BLOB_CACHE_MAX_BYTES = 96 * 1024 * 1024
// One cat-file batch per round; extraction spends its budget between rounds, like sequential reads.
const CATALOG_BLOB_ROUND_MAX_BYTES = 32 * 1024 * 1024

export type PluginMarketplaceFetchResult = {
  marketplaceCommit: string
  marketplace: PluginMarketplace
  /** Catalog images whose bytes matched their declared hash, size and format. */
  images?: Buffer[]
}

/** System Git retains private-repo SSH agent and credential-helper support. */
export async function fetchPluginMarketplace(
  source: PluginMarketplaceRegisteredSource
): Promise<PluginMarketplaceFetchResult> {
  const { commit, value } = await readPluginGitCommit(
    {
      url: source.source.url,
      ref: source.source.ref,
      workingDirectory: tmpdir(),
      maxDownloadBytes: MARKETPLACE_DOWNLOAD_MAX_BYTES
    },
    (repository, commit) => readMarketplaceAtCommit(repository, commit, source.source.url)
  )
  return { marketplaceCommit: commit, marketplace: value.marketplace, images: value.images }
}

/** Reads only the catalog index blobs, so the rest of the repository is never written out.
 *  Prefers orca-catalog.json; repositories that only publish the frozen v1 file still load. */
async function readMarketplaceAtCommit(
  repository: string,
  commit: string,
  catalogUrl: string
): Promise<{ marketplace: PluginMarketplace; images: Buffer[] }> {
  const options = { cwd: repository, timeout: MARKETPLACE_GIT_TIMEOUT_MS }
  const listing = await gitExecFileAsyncBuffer(
    ['ls-tree', '-l', '-z', commit, '--', PLUGIN_CATALOG_FILENAME, PLUGIN_MARKETPLACE_FILENAME],
    { ...options, maxBuffer: 64 * 1024 }
  )
  const blobs = new Map<string, { object: string; size: number }>()
  for (const record of listing.stdout.toString('utf8').split('\0')) {
    const match = /^100(?:644|755) blob ([0-9a-f]{40}) +([0-9]+)\t(.+)$/s.exec(record)
    if (match) {
      blobs.set(match[3]!, { object: match[1]!, size: Number(match[2]) })
    }
  }
  const filename = blobs.has(PLUGIN_CATALOG_FILENAME)
    ? PLUGIN_CATALOG_FILENAME
    : PLUGIN_MARKETPLACE_FILENAME
  const blob = blobs.get(filename)
  if (!blob) {
    throw new Error(`${PLUGIN_MARKETPLACE_FILENAME} not found`)
  }
  if (blob.size > MARKETPLACE_INDEX_MAX_BYTES) {
    throw new Error(`${filename} exceeds its size limit`)
  }
  const bytes = await gitExecFileAsyncBuffer(['cat-file', 'blob', blob.object], {
    ...options,
    maxBuffer: MARKETPLACE_INDEX_MAX_BYTES
  })
  const index = parsePluginMarketplaceIndex(filename, bytes.stdout)
  const batched = await extractBatchedMarketplaceImages(index, repository, commit, catalogUrl)
  if (batched) {
    return batched
  }
  const readBlob: CatalogBlobReader = async (path, maxBytes) => {
    const files = new Map<string, CatalogFile>()
    await loadCatalogFiles(repository, commit, new Map([[path, maxBytes]]), files, new Map())
    return files.get(path)?.bytes ?? null
  }
  return extractCatalogImages(index, readBlob, (entry, read) =>
    fillMonorepoReleaseImages(entry, catalogUrl, read)
  )
}

async function extractBatchedMarketplaceImages(
  index: PluginMarketplace,
  repository: string,
  commit: string,
  catalogUrl: string
): Promise<{ marketplace: PluginMarketplace; images: Buffer[] } | null> {
  const files = new Map<string, CatalogFile>()
  const listed = new Map<string, ListedBlob>()
  // Rerun extraction until every file it asks for is loaded, so each round's misses share a few Git calls.
  for (;;) {
    const missing = new Map<string, number>()
    const readBlob = async (path: string, maxBytes: number): Promise<Buffer | null> => {
      const file = files.get(path)
      if (file === undefined || (file && !file.bytes && file.size <= maxBytes)) {
        missing.set(path, Math.max(missing.get(path) ?? 0, maxBytes))
        return null
      }
      return file?.bytes && file.size <= maxBytes ? file.bytes : null
    }
    const extracted = await extractCatalogImages(index, readBlob, (entry, read) =>
      fillMonorepoReleaseImages(entry, catalogUrl, read)
    )
    if (missing.size === 0) {
      return extracted
    }
    if (!(await loadCatalogFiles(repository, commit, missing, files, listed))) {
      return null
    }
  }
}

/** A regular file's size and, when it fit the largest requested limit, its bytes; null when absent. */
type CatalogFile = { size: number; bytes: Buffer | null } | null
type ListedBlob = { object: string; size: number } | null

// Keep each ls-tree argv well under the Windows command-line limit.
const LS_TREE_PATH_CHUNK_CHARS = 16 * 1024

/** Loads files from the catalog commit, refusing to read any larger than its requested limit.
 *  Reads past the round's byte cap stay unloaded so the next extraction pass asks again with its
 *  remaining image budget. False once retaining another file would pass the retained cap. */
async function loadCatalogFiles(
  repository: string,
  commit: string,
  requests: ReadonlyMap<string, number>,
  files: Map<string, CatalogFile>,
  listed: Map<string, ListedBlob>
): Promise<boolean> {
  const options = { cwd: repository, timeout: MARKETPLACE_GIT_TIMEOUT_MS }
  const unlisted = [...requests.keys()].filter((path) => !listed.has(path))
  for (const chunk of chunkByLength(unlisted, LS_TREE_PATH_CHUNK_CHARS)) {
    try {
      const listing = await gitExecFileAsyncBuffer(
        ['ls-tree', '-l', '-z', commit, '--', ...chunk],
        {
          ...options,
          maxBuffer: chunk.length * 4 * 1024
        }
      )
      const entries = new Map<string, { object: string; size: number }>()
      for (const record of listing.stdout.toString('utf8').split('\0')) {
        const match = /^100(?:644|755) blob ([0-9a-f]{40}) +([0-9]+)\t(.+)$/s.exec(record)
        if (match) {
          entries.set(match[3]!, { object: match[1]!, size: Number(match[2]) })
        }
      }
      for (const path of chunk) {
        listed.set(path, entries.get(gitTreePath(path)) ?? null)
      }
    } catch {
      for (const path of chunk) {
        listed.set(path, null)
      }
    }
  }
  let retainedBytes = 0
  for (const file of files.values()) {
    retainedBytes += file?.bytes?.byteLength ?? 0
  }
  const reads: Extract<PluginGitTreeEntry, { kind: 'blob' }>[] = []
  let roundBytes = 0
  for (const [path, maxBytes] of requests) {
    const found = listed.get(path)
    if (found && found.size > maxBytes) {
      files.set(path, { size: found.size, bytes: null })
      continue
    }
    if (!found) {
      files.set(path, null)
      continue
    }
    if (retainedBytes + found.size > CATALOG_BLOB_CACHE_MAX_BYTES) {
      // Sequential reads keep only what extraction holds, so a catalog this large still loads.
      return false
    }
    if (reads.length > 0 && roundBytes + found.size > CATALOG_BLOB_ROUND_MAX_BYTES) {
      continue
    }
    roundBytes += found.size
    retainedBytes += found.size
    reads.push({ kind: 'blob', path, object: found.object, size: found.size, executable: false })
  }
  if (reads.length === 0) {
    return true
  }
  try {
    const objects = [...new Map(reads.map((read) => [read.object, read])).values()]
    const batch = await gitExecFileAsyncBuffer(['cat-file', '--batch'], {
      ...options,
      stdin: objects.map((read) => `${read.object}\n`).join(''),
      maxBuffer: objects.reduce((total, read) => total + read.size + 128, 0)
    })
    const contents = readPluginGitBatchBlobs(batch.stdout, objects)
    for (const read of reads) {
      files.set(read.path, { size: read.size, bytes: contents.get(read.object) ?? null })
    }
  } catch {
    for (const read of reads) {
      files.set(read.path, null)
    }
  }
  return true
}

function chunkByLength(paths: string[], maxChars: number): string[][] {
  const chunks: string[][] = []
  let chars = maxChars
  for (const path of paths) {
    if (chars + path.length > maxChars) {
      chunks.push([])
      chars = 0
    }
    chunks.at(-1)!.push(path)
    chars += path.length + 1
  }
  return chunks
}

/** Git for Windows accepts either separator in a pathspec but always lists `/`. */
function gitTreePath(path: string): string {
  return process.platform === 'win32' ? path.replaceAll('\\', '/') : path
}

export function parsePluginMarketplaceIndex(filename: string, bytes: Buffer): PluginMarketplace {
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(
      `invalid ${filename}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (filename === PLUGIN_CATALOG_FILENAME) {
    const tooNew = pluginCatalogVersionError(raw)
    if (tooNew) {
      throw new Error(`${filename} ${tooNew}`)
    }
    const parsed = pluginCatalogSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`invalid ${filename}: ${formatPluginSchemaIssues(parsed.error.issues, raw)}`)
    }
    const { name, owner, plugins } = parsed.data
    return { name, owner, plugins }
  }
  const parsed = pluginMarketplaceSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`invalid ${filename}: ${formatPluginSchemaIssues(parsed.error.issues, raw)}`)
  }
  return parsed.data
}
