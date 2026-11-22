import { join } from 'node:path'
import {
  loadCatalogFiles,
  MARKETPLACE_GIT_TIMEOUT_MS,
  type CatalogLoadState
} from './plugin-catalog-blob-reader'
import type { PluginCatalogRepositoryStore } from './plugin-catalog-repository'
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
import { createCatalogBufferMemo, type CatalogBlobReader } from './plugin-catalog-image-extraction'
import { fillMonorepoReleaseImages } from './plugin-catalog-monorepo-images'
import type {
  CatalogRepositorySlot,
  PluginMarketplaceCachedSnapshot,
  PluginMarketplaceRegisteredSource
} from './plugin-marketplace-store'

const MARKETPLACE_INDEX_MAX_BYTES = 16 * 1024 * 1024
export type PluginMarketplaceFetchResult = {
  marketplaceCommit: string
  marketplace: PluginMarketplace
}

/** System Git retains private-repo SSH agent and credential-helper support. */
export async function fetchPluginMarketplace<T>(
  source: PluginMarketplaceRegisteredSource,
  options: {
    repositories: Pick<PluginCatalogRepositoryStore, 'refresh'>
    published: PluginMarketplaceCachedSnapshot | null
  },
  save: (result: PluginMarketplaceFetchResult, slot: CatalogRepositorySlot) => Promise<T>
): Promise<T> {
  return options.repositories.refresh(
    source,
    options.published,
    async (repository, revision, slot) =>
      save(
        {
          marketplaceCommit: revision,
          marketplace: await readMarketplaceAtCommit(repository, revision, source.source.url)
        },
        slot
      )
  )
}

/** Prefers orca-catalog.json; repositories that only publish the frozen v1 file still load. */
async function readMarketplaceAtCommit(
  repository: string,
  commit: string,
  catalogUrl: string
): Promise<PluginMarketplace> {
  const options = { cwd: repository, timeout: MARKETPLACE_GIT_TIMEOUT_MS }
  const listing = await gitExecFileAsyncBuffer(
    [
      '--git-dir',
      join(repository, '.git'),
      'ls-tree',
      '-l',
      '-z',
      commit,
      '--',
      PLUGIN_CATALOG_FILENAME,
      PLUGIN_MARKETPLACE_FILENAME
    ],
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
  const bytes = await gitExecFileAsyncBuffer(
    ['--git-dir', join(repository, '.git'), 'cat-file', 'blob', blob.object],
    {
      ...options,
      maxBuffer: MARKETPLACE_INDEX_MAX_BYTES
    }
  )
  const index = parsePluginMarketplaceIndex(filename, bytes.stdout)
  const loaded: CatalogLoadState = {
    files: new Map(),
    listed: new Map(),
    failed: new Set(),
    memo: createCatalogBufferMemo()
  }
  const batched = await fillBatchedMarketplaceImages(index, repository, commit, catalogUrl, loaded)
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
  return fillMarketplaceImages(index, catalogUrl, readBlob, memo)
}

async function fillBatchedMarketplaceImages(
  index: PluginMarketplace,
  repository: string,
  commit: string,
  catalogUrl: string,
  state: CatalogLoadState
): Promise<PluginMarketplace | null> {
  // Repeat the manifest fallback so its missing files share a Git batch.
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
    const filled = await fillMarketplaceImages(index, catalogUrl, readBlob, state.memo)
    if (missing.size === 0) {
      return filled
    }
    if (!(await loadCatalogFiles(repository, commit, missing, state))) {
      return null
    }
  }
}

async function fillMarketplaceImages(
  marketplace: PluginMarketplace,
  catalogUrl: string,
  readBlob: CatalogBlobReader,
  memo: CatalogLoadState['memo']
): Promise<PluginMarketplace> {
  const plugins: PluginMarketplace['plugins'] = []
  for (const entry of marketplace.plugins) {
    plugins.push(await fillMonorepoReleaseImages(entry, catalogUrl, readBlob, memo))
  }
  return { ...marketplace, plugins }
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
