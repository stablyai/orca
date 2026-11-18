import {
  loadCatalogFiles,
  MARKETPLACE_GIT_TIMEOUT_MS,
  type CatalogLoadState
} from './plugin-catalog-blob-reader'
import type { PluginCatalogRepositoryStore } from './plugin-catalog-repository'
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
import {
  createCatalogBufferMemo,
  extractCatalogImages,
  type CatalogBlobReader
} from './plugin-catalog-image-extraction'
import { fillMonorepoReleaseImages } from './plugin-catalog-monorepo-images'
import { readPluginGitCommit } from '../installation/plugin-git-repository'
import type { PluginMarketplaceRegisteredSource } from './plugin-marketplace-store'

const MARKETPLACE_INDEX_MAX_BYTES = 16 * 1024 * 1024
// Why its own cap: a catalog repository may hold far more than one plugin, and only its index is read.
const MARKETPLACE_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024
export type PluginMarketplaceFetchResult = {
  marketplaceCommit: string
  marketplace: PluginMarketplace
  /** Catalog images whose bytes matched their declared hash, size and format. */
  images?: Buffer[]
}

/** System Git retains private-repo SSH agent and credential-helper support. */
export async function fetchPluginMarketplace(
  source: PluginMarketplaceRegisteredSource,
  options: {
    repositories?: Pick<PluginCatalogRepositoryStore, 'refresh'>
    publishedCommit?: string
  } = {}
): Promise<PluginMarketplaceFetchResult> {
  const onDemand = Boolean(options.repositories) && isOnDemandCatalogSource(source.source.url)
  const read = (repository: string, commit: string) =>
    readMarketplaceAtCommit(repository, commit, source.source.url, onDemand)
  const { commit, value } = options.repositories
    ? await options.repositories.refresh(source, read, options.publishedCommit)
    : await readPluginGitCommit(
        {
          url: source.source.url,
          ref: source.source.ref,
          workingDirectory: tmpdir(),
          maxDownloadBytes: MARKETPLACE_DOWNLOAD_MAX_BYTES
        },
        read
      )
  return { marketplaceCommit: commit, marketplace: value.marketplace, images: value.images }
}

/** Reads only the catalog index blobs, so the rest of the repository is never written out.
 *  Prefers orca-catalog.json; repositories that only publish the frozen v1 file still load. */
async function readMarketplaceAtCommit(
  repository: string,
  commit: string,
  catalogUrl: string,
  onDemand: boolean
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
  const loaded: CatalogLoadState = {
    files: new Map(),
    listed: new Map(),
    failed: new Set(),
    memo: createCatalogBufferMemo()
  }
  const batched = await extractBatchedMarketplaceImages(
    index,
    repository,
    commit,
    catalogUrl,
    loaded,
    onDemand
  )
  if (batched) {
    return batched
  }
  const { files, failed, memo } = loaded
  // Past the retained cap, read the rest one at a time, handing out each loaded file once so only what extraction keeps stays alive.
  // Failed Git reads are retried, as a fresh one-at-a-time reader would.
  const readBlob: CatalogBlobReader = async (path, maxBytes) => {
    const file = failed.has(path) ? undefined : files.get(path)
    files.delete(path)
    if (file === null || (file && file.size > maxBytes)) {
      return null
    }
    if (file?.bytes) {
      return file.bytes
    }
    const single: CatalogLoadState = { ...loaded, files: new Map(), failed: new Set() }
    await loadCatalogFiles(repository, commit, new Map([[path, maxBytes]]), single)
    return single.files.get(path)?.bytes ?? null
  }
  return extractCatalogImages(
    index,
    readBlob,
    (entry, read) => fillMonorepoReleaseImages(entry, catalogUrl, read, memo),
    memo,
    onDemand
  )
}

async function extractBatchedMarketplaceImages(
  index: PluginMarketplace,
  repository: string,
  commit: string,
  catalogUrl: string,
  state: CatalogLoadState,
  onDemand: boolean
): Promise<{ marketplace: PluginMarketplace; images: Buffer[] } | null> {
  // Rerun extraction until every file it asks for is loaded, so each round's misses share a few Git calls.
  for (;;) {
    const missing = new Map<string, number>()
    const readBlob = async (path: string, maxBytes: number): Promise<Buffer | null> => {
      const file = state.files.get(path)
      if (file === undefined || (file && !file.bytes && file.size <= maxBytes)) {
        missing.set(path, Math.max(missing.get(path) ?? 0, maxBytes))
        return null
      }
      return file?.bytes && file.size <= maxBytes ? file.bytes : null
    }
    const extracted = await extractCatalogImages(
      index,
      readBlob,
      (entry, read) => fillMonorepoReleaseImages(entry, catalogUrl, read, state.memo),
      state.memo,
      onDemand
    )
    if (missing.size === 0) {
      return extracted
    }
    if (!(await loadCatalogFiles(repository, commit, missing, state))) {
      return null
    }
  }
}

export function isOnDemandCatalogSource(url: string): boolean {
  try {
    const source = new URL(url)
    return (
      source.protocol === 'https:' &&
      source.hostname === 'github.com' &&
      !source.username &&
      !source.password &&
      !source.port &&
      !source.search &&
      !source.hash &&
      /^\/[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+\/?$/.test(source.pathname)
    )
  } catch {
    return false
  }
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
