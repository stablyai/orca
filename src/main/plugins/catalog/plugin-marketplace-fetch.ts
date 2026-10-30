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
import { gitExecFileAsyncBuffer } from '../../git/runner'
import { extractCatalogImages } from './plugin-catalog-image-extraction'
import { fillMonorepoReleaseImages } from './plugin-catalog-monorepo-images'
import { readPluginGitCommit } from '../installation/plugin-git-repository'
import type { PluginMarketplaceRegisteredSource } from './plugin-marketplace-store'

const MARKETPLACE_INDEX_MAX_BYTES = 16 * 1024 * 1024
// Why its own cap: a catalog repository may hold far more than one plugin, and only its index is read.
const MARKETPLACE_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024
const MARKETPLACE_GIT_TIMEOUT_MS = 120_000

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
  const readBlob = (path: string, maxBytes: number): Promise<Buffer | null> =>
    readCatalogBlob(repository, commit, path, maxBytes)
  return extractCatalogImages(
    parsePluginMarketplaceIndex(filename, bytes.stdout),
    readBlob,
    (entry, read) => fillMonorepoReleaseImages(entry, catalogUrl, read)
  )
}

/** One file from the catalog commit, refused before reading when it is larger than allowed. */
async function readCatalogBlob(
  repository: string,
  commit: string,
  path: string,
  maxBytes: number
): Promise<Buffer | null> {
  const options = { cwd: repository, timeout: MARKETPLACE_GIT_TIMEOUT_MS }
  const listing = await gitExecFileAsyncBuffer(['ls-tree', '-l', '-z', commit, '--', path], {
    ...options,
    maxBuffer: 4 * 1024
  })
  const match = /^100(?:644|755) blob ([0-9a-f]{40}) +([0-9]+)\t/.exec(
    listing.stdout.toString('utf8')
  )
  if (!match?.[1] || Number(match[2]) > maxBytes) {
    return null
  }
  const blob = await gitExecFileAsyncBuffer(['cat-file', 'blob', match[1]], {
    ...options,
    maxBuffer: maxBytes
  })
  return blob.stdout
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
