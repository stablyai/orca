import { createHash } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import {
  pluginMarketplaceGitSourceSchema,
  type PluginMarketplace,
  type PluginMarketplaceGitSource
} from '../../../shared/plugins/catalog/plugin-marketplace'
import { writePluginFileAtomically } from '../installation/plugin-atomic-file-write'

import {
  cachedSnapshotSchema,
  readBoundedText,
  readSnapshotFromDisk,
  SNAPSHOT_FILE_MAX_BYTES,
  type CatalogRepositorySlot,
  type PluginMarketplaceCachedSnapshot
} from './plugin-marketplace-snapshot-file'
export {
  snapshotRepositorySlot,
  type CatalogRepositorySlot,
  type PluginMarketplaceCachedSnapshot
} from './plugin-marketplace-snapshot-file'

export const PLUGIN_MARKETPLACE_SOURCE_LIMIT = 64
export const PLUGIN_MARKETPLACE_SOURCE_ID_PATTERN = /^[0-9a-f]{32}$/

const sourceIdSchema = lazyZodSchema(() => z.string().regex(PLUGIN_MARKETPLACE_SOURCE_ID_PATTERN))
const registeredSourceSchema = lazyZodSchema(() =>
  z.strictObject({
    id: sourceIdSchema,
    source: pluginMarketplaceGitSourceSchema,
    addedAt: z.number().finite().nonnegative()
  })
)
const sourceFileSchema = lazyZodSchema(() =>
  z.strictObject({
    schemaVersion: z.literal(1),
    sources: z.array(registeredSourceSchema).max(PLUGIN_MARKETPLACE_SOURCE_LIMIT)
  })
)
export type PluginMarketplaceRegisteredSource = z.infer<typeof registeredSourceSchema>

// Why a separate file: sources.json is parsed strictly by older builds, so it can't gain fields.
const seededDefaultsSchema = lazyZodSchema(() =>
  z.object({
    schemaVersion: z.literal(1),
    seeded: z.array(z.string().max(64)).max(16)
  })
)
export type PluginMarketplaceDefaultSource = 'community'

const SOURCE_FILE_MAX_BYTES = 2 * 1024 * 1024

export function marketplaceSourceId(source: PluginMarketplaceGitSource): string {
  const parsed = pluginMarketplaceGitSourceSchema.parse(source)
  return createHash('sha256')
    .update(`orca-plugin-marketplace-source-v1\0${parsed.url}\0${parsed.ref}`)
    .digest('hex')
    .slice(0, 32)
}

export class PluginMarketplaceStore {
  /** Sees each snapshot as it becomes current: `published` by a write, otherwise loaded from disk. */
  observeSnapshots?: (snapshot: PluginMarketplaceCachedSnapshot, published: boolean) => void
  private readonly sourcesPath: string
  private readonly seededDefaultsPath: string
  private readonly snapshotDirectory: string
  private sources: PluginMarketplaceRegisteredSource[] | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private readonly snapshots = new Map<
    string,
    {
      read: Promise<PluginMarketplaceCachedSnapshot | null>
      value?: PluginMarketplaceCachedSnapshot | null
    }
  >()

  constructor(pluginsDataDir: string) {
    const root = join(pluginsDataDir, 'marketplaces')
    this.sourcesPath = join(root, 'sources.json')
    this.seededDefaultsPath = join(root, 'seeded-defaults.json')
    this.snapshotDirectory = join(root, 'snapshots')
  }

  async listSources(): Promise<readonly PluginMarketplaceRegisteredSource[]> {
    await this.loadSources()
    return this.sources!
  }

  registeredSource(sourceId: string): PluginMarketplaceRegisteredSource | undefined {
    return this.sources?.find(({ id }) => id === sourceId)
  }

  async snapshotSourceIds(): Promise<string[]> {
    const files = await readdir(this.snapshotDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error
      }
      return []
    })
    return files.flatMap((file) => {
      const id = /^([0-9a-f]{32})(?:\.v2)?\.json$/.exec(file)?.[1]
      return id ? [id] : []
    })
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
      await this.clearSnapshot(parsedId)
    }
    return removed
  }

  async clearSnapshot(sourceId: string): Promise<void> {
    const id = sourceIdSchema.parse(sourceId)
    this.snapshots.delete(id)
    try {
      await rm(this.snapshotPath(id), { force: true })
      await rm(this.legacySnapshotPath(id), { force: true })
    } finally {
      this.snapshots.delete(id)
    }
  }

  /** Whether Orca already added this default source once; a user's later removal must stick. */
  async hasSeededDefault(name: PluginMarketplaceDefaultSource): Promise<boolean> {
    return (await this.readSeededDefaults()).includes(name)
  }

  async markDefaultSeeded(name: PluginMarketplaceDefaultSource): Promise<void> {
    const seeded = await this.readSeededDefaults()
    if (!seeded.includes(name)) {
      await writeAtomicJson(this.seededDefaultsPath, {
        schemaVersion: 1,
        seeded: [...seeded, name]
      })
    }
  }

  private async readSeededDefaults(): Promise<string[]> {
    try {
      return seededDefaultsSchema.parse(
        JSON.parse(await readBoundedText(this.seededDefaultsPath, SOURCE_FILE_MAX_BYTES))
      ).seeded
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return []
      }
      // Why seeded on corruption: re-adding a source the user removed is worse than not adding it.
      return ['community']
    }
  }

  async writeSnapshot(input: {
    source: PluginMarketplaceRegisteredSource
    marketplaceCommit: string
    fetchedAt?: number
    catalogRepository?: CatalogRepositorySlot
    marketplace: PluginMarketplace
  }): Promise<PluginMarketplaceCachedSnapshot> {
    const snapshot = cachedSnapshotSchema.parse({
      schemaVersion: 2,
      sourceId: input.source.id,
      source: input.source.source,
      marketplaceCommit: input.marketplaceCommit,
      fetchedAt: input.fetchedAt ?? Date.now(),
      ...(input.catalogRepository === 'replacement'
        ? { catalogRepository: input.catalogRepository }
        : {}),
      marketplace: input.marketplace
    })
    const path = this.snapshotPath(input.source.id)
    const text = `${JSON.stringify(snapshot)}\n`
    if (Buffer.byteLength(text) > SNAPSHOT_FILE_MAX_BYTES) {
      throw new Error('marketplace snapshot exceeds its size limit')
    }
    await mkdir(this.snapshotDirectory, { recursive: true })
    await writePluginFileAtomically(path, text)
    this.snapshots.set(input.source.id, { read: Promise.resolve(snapshot), value: snapshot })
    this.observeSnapshots?.(snapshot, true)
    return snapshot
  }

  /** Parsed once per process; every write goes through this store, which keeps it current. */
  async readSnapshot(sourceId: string): Promise<PluginMarketplaceCachedSnapshot | null> {
    const parsedId = sourceIdSchema.parse(sourceId)
    const cached = this.snapshots.get(parsedId)
    if (cached) {
      return cached.read
    }
    const pending: NonNullable<ReturnType<typeof this.snapshots.get>> = {
      read: readSnapshotFromDisk(
        parsedId,
        this.snapshotPath(parsedId),
        this.legacySnapshotPath(parsedId)
      ).then(
        (value) => {
          pending.value = value
          if (value && this.snapshots.get(parsedId) === pending) {
            this.observeSnapshots?.(value, false)
          }
          return value
        },
        (error: unknown) => {
          if (this.snapshots.get(parsedId) === pending) {
            this.snapshots.delete(parsedId)
          }
          throw error
        }
      )
    }
    this.snapshots.set(parsedId, pending)
    return pending.read
  }

  currentSnapshot(sourceId: string): PluginMarketplaceCachedSnapshot | null | undefined {
    return this.snapshots.get(sourceId)?.value
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
      this.sources ??= parsed.sources
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.sources ??= []
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
        const next = mutation(this.sources!)
        const file = sourceFileSchema.parse({ schemaVersion: 1, sources: next })
        await writeAtomicJson(this.sourcesPath, file)
        this.sources = next
      })
    this.writeChain = update
    await update
  }

  private snapshotPath(sourceId: string): string {
    return join(this.snapshotDirectory, `${sourceId}.v2.json`)
  }

  private legacySnapshotPath(sourceId: string): string {
    return join(this.snapshotDirectory, `${sourceId}.json`)
  }
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writePluginFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`)
}
