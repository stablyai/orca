import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PLUGIN_MARKETPLACE_FILENAME,
  pluginMarketplaceSchema,
  type PluginMarketplace
} from '../../shared/plugins/plugin-marketplace'
import { checkoutPluginGitSource } from './plugin-git-repository'
import type { PluginMarketplaceRegisteredSource } from './plugin-marketplace-store'

const MARKETPLACE_INDEX_MAX_BYTES = 16 * 1024 * 1024

export type PluginMarketplaceFetchResult = {
  marketplaceCommit: string
  marketplace: PluginMarketplace
}

/** Fetches a marketplace through system Git so private repositories use the
 * same SSH agent and credential helpers as every other Orca Git operation. */
export async function fetchPluginMarketplace(
  source: PluginMarketplaceRegisteredSource
): Promise<PluginMarketplaceFetchResult> {
  const stagingDirectory = await mkdtemp(join(tmpdir(), 'orca-plugin-marketplace-'))
  try {
    const marketplaceCommit = await checkoutPluginGitSource({
      url: source.source.url,
      ref: source.source.ref,
      destination: stagingDirectory,
      workingDirectory: tmpdir()
    })
    const marketplace = await readPluginMarketplaceIndex(stagingDirectory)
    return { marketplaceCommit, marketplace }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}

export async function readPluginMarketplaceIndex(
  rootDirectory: string
): Promise<PluginMarketplace> {
  const raw = await readMarketplaceJson(rootDirectory, PLUGIN_MARKETPLACE_FILENAME)
  return parseMarketplaceFile(PLUGIN_MARKETPLACE_FILENAME, () => pluginMarketplaceSchema.parse(raw))
}

async function readMarketplaceJson(rootDirectory: string, filename: string): Promise<unknown> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of createReadStream(join(rootDirectory, filename))) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += bytes.byteLength
    if (totalBytes > MARKETPLACE_INDEX_MAX_BYTES) {
      throw new Error(`${filename} exceeds its size limit`)
    }
    chunks.push(bytes)
  }
  return parseMarketplaceFile(filename, () =>
    JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'))
  )
}

function parseMarketplaceFile<T>(filename: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    throw new Error(
      `invalid ${filename}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
