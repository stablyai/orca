import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { PLUGIN_COMMIT_PATTERN } from '../../shared/plugins/plugin-install-lockfile'
import {
  pluginMarketplaceGitSourceSchema,
  pluginMarketplaceSchema,
  type PluginMarketplace,
  type PluginMarketplaceGitSource
} from '../../shared/plugins/plugin-marketplace'
import { writePluginFileAtomically } from './plugin-atomic-file-write'

export const PLUGIN_MARKETPLACE_SOURCE_LIMIT = 64
export const PLUGIN_MARKETPLACE_SOURCE_ID_PATTERN = /^[0-9a-f]{32}$/

const sourceIdSchema = z.string().regex(PLUGIN_MARKETPLACE_SOURCE_ID_PATTERN)
const registeredSourceSchema = z.strictObject({
  id: sourceIdSchema,
  source: pluginMarketplaceGitSourceSchema,
  addedAt: z.number().finite().nonnegative()
})
const sourceFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sources: z.array(registeredSourceSchema).max(PLUGIN_MARKETPLACE_SOURCE_LIMIT)
})
const cachedSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceId: sourceIdSchema,
  source: pluginMarketplaceGitSourceSchema,
  marketplaceCommit: z.string().regex(PLUGIN_COMMIT_PATTERN),
  fetchedAt: z.number().finite().nonnegative(),
  marketplace: pluginMarketplaceSchema
})

export type PluginMarketplaceRegisteredSource = z.infer<typeof registeredSourceSchema>
export type PluginMarketplaceCachedSnapshot = z.infer<typeof cachedSnapshotSchema>

const SOURCE_FILE_MAX_BYTES = 2 * 1024 * 1024
const SNAPSHOT_FILE_MAX_BYTES = 16 * 1024 * 1024

export function marketplaceSourceId(source: PluginMarketplaceGitSource): string {
  const parsed = pluginMarketplaceGitSourceSchema.parse(source)
  return createHash('sha256')
    .update(`orca-plugin-marketplace-source-v1\0${parsed.url}\0${parsed.ref}`)
    .digest('hex')
    .slice(0, 32)
}

export class PluginMarketplaceStore {
  private readonly sourcesPath: string
  private readonly snapshotDirectory: string
  private sources: PluginMarketplaceRegisteredSource[] | null = null
  private writeChain: Promise<void> = Promise.resolve()

  constructor(pluginsDataDir: string) {
    const root = join(pluginsDataDir, 'marketplaces')
    this.sourcesPath = join(root, 'sources.json')
    this.snapshotDirectory = join(root, 'snapshots')
  }

  async listSources(): Promise<readonly PluginMarketplaceRegisteredSource[]> {
    await this.loadSources()
    return this.sources!
  }

  async addSource(
    source: PluginMarketplaceGitSource,
    addedAt = Date.now()
  ): Promise<PluginMarketplaceRegisteredSource> {
    const parsedSource = pluginMarketplaceGitSourceSchema.parse(source)
    const registration = registeredSourceSchema.parse({
      id: marketplaceSourceId(parsedSource),
      source: parsedSource,
      addedAt
    })
    await this.mutateSources((sources) => {
      if (sources.some((candidate) => candidate.id === registration.id)) {
        return [...sources]
      }
      if (sources.length >= PLUGIN_MARKETPLACE_SOURCE_LIMIT) {
        throw new Error(`marketplace source limit (${PLUGIN_MARKETPLACE_SOURCE_LIMIT}) reached`)
      }
      return [...sources, registration]
    })
    return this.sources!.find((candidate) => candidate.id === registration.id)!
  }

  async removeSource(sourceId: string): Promise<boolean> {
    const parsedId = sourceIdSchema.parse(sourceId)
    let removed = false
    await this.mutateSources((sources) => {
      const next = sources.filter((source) => source.id !== parsedId)
      removed = next.length !== sources.length
      return next
    })
    if (removed) {
      await rm(this.snapshotPath(parsedId), { force: true })
    }
    return removed
  }

  async writeSnapshot(input: {
    source: PluginMarketplaceRegisteredSource
    marketplaceCommit: string
    fetchedAt?: number
    marketplace: PluginMarketplace
  }): Promise<PluginMarketplaceCachedSnapshot> {
    const snapshot = cachedSnapshotSchema.parse({
      schemaVersion: 1,
      sourceId: input.source.id,
      source: input.source.source,
      marketplaceCommit: input.marketplaceCommit,
      fetchedAt: input.fetchedAt ?? Date.now(),
      marketplace: input.marketplace
    })
    await writeAtomicJson(this.snapshotPath(input.source.id), snapshot)
    return snapshot
  }

  async readSnapshot(sourceId: string): Promise<PluginMarketplaceCachedSnapshot | null> {
    const parsedId = sourceIdSchema.parse(sourceId)
    try {
      const raw = JSON.parse(
        await readBoundedText(this.snapshotPath(parsedId), SNAPSHOT_FILE_MAX_BYTES)
      )
      const parsed = cachedSnapshotSchema.parse(raw)
      if (parsed.sourceId !== parsedId) {
        throw new Error('marketplace snapshot source identity does not match its cache path')
      }
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw new Error(
        `marketplace snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private async loadSources(): Promise<void> {
    if (this.sources !== null) {
      return
    }
    try {
      const parsed = sourceFileSchema.parse(
        JSON.parse(await readBoundedText(this.sourcesPath, SOURCE_FILE_MAX_BYTES))
      )
      const ids = new Set<string>()
      for (const source of parsed.sources) {
        if (source.id !== marketplaceSourceId(source.source) || ids.has(source.id)) {
          throw new Error('marketplace source identity is inconsistent or duplicated')
        }
        ids.add(source.id)
      }
      this.sources = parsed.sources
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.sources = []
        return
      }
      throw new Error(
        `marketplace sources are invalid: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private async mutateSources(
    mutation: (
      sources: readonly PluginMarketplaceRegisteredSource[]
    ) => PluginMarketplaceRegisteredSource[]
  ): Promise<void> {
    const update = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await this.loadSources()
        const next = sourceFileSchema.parse({
          schemaVersion: 1,
          sources: mutation(this.sources!)
        }).sources
        await writeAtomicJson(this.sourcesPath, { schemaVersion: 1, sources: next })
        this.sources = next
      })
    this.writeChain = update
    await update
  }

  private snapshotPath(sourceId: string): string {
    return join(this.snapshotDirectory, `${sourceId}.json`)
  }
}

async function readBoundedText(path: string, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += bytes.byteLength
    if (totalBytes > limit) {
      throw new Error(`file exceeds its ${limit}-byte limit`)
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8')
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writePluginFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`)
}
