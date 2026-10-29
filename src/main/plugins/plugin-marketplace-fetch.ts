import { tmpdir } from 'node:os'
import {
  PLUGIN_MARKETPLACE_FILENAME,
  PLUGIN_MARKETPLACE_V2_FILENAME,
  pluginMarketplaceSchema,
  pluginMarketplaceV2Schema,
  type PluginMarketplace
} from '../../shared/plugins/plugin-marketplace'
import { gitExecFileAsyncBuffer } from '../git/runner'
import { readPluginGitCommit } from './plugin-git-repository'
import type { PluginMarketplaceRegisteredSource } from './plugin-marketplace-store'

const MARKETPLACE_INDEX_MAX_BYTES = 16 * 1024 * 1024
// Why its own cap: a catalog repository may hold far more than one plugin, and only its index is read.
const MARKETPLACE_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024
const MARKETPLACE_GIT_TIMEOUT_MS = 120_000

export type PluginMarketplaceFetchResult = {
  marketplaceCommit: string
  marketplace: PluginMarketplace
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
    readMarketplaceAtCommit
  )
  return { marketplaceCommit: commit, marketplace: value }
}

/** Reads only the catalog index blobs, so the rest of the repository is never written out.
 *  Prefers the release-pinned v2 catalog; repositories that only publish v1 still load. */
async function readMarketplaceAtCommit(
  repository: string,
  commit: string
): Promise<PluginMarketplace> {
  const options = { cwd: repository, timeout: MARKETPLACE_GIT_TIMEOUT_MS }
  const listing = await gitExecFileAsyncBuffer(
    [
      'ls-tree',
      '-l',
      '-z',
      commit,
      '--',
      PLUGIN_MARKETPLACE_V2_FILENAME,
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
  const filename = blobs.has(PLUGIN_MARKETPLACE_V2_FILENAME)
    ? PLUGIN_MARKETPLACE_V2_FILENAME
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
  return parsePluginMarketplaceIndex(filename, bytes.stdout)
}

export function parsePluginMarketplaceIndex(filename: string, bytes: Buffer): PluginMarketplace {
  try {
    const raw: unknown = JSON.parse(bytes.toString('utf8'))
    return filename === PLUGIN_MARKETPLACE_V2_FILENAME
      ? pluginMarketplaceV2Schema.parse(raw)
      : pluginMarketplaceSchema.parse(raw)
  } catch (error) {
    throw new Error(
      `invalid ${filename}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
