import { createReadStream } from 'node:fs'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { PLUGIN_COMMIT_PATTERN } from '../../../shared/plugins/installation/plugin-install-lockfile'
import {
  pluginMarketplaceGitSourceSchema,
  pluginMarketplaceListingSchema,
  pluginMarketplaceSchema
} from '../../../shared/plugins/catalog/plugin-marketplace'

const sourceIdSchema = lazyZodSchema(() => z.string().regex(/^[0-9a-f]{32}$/))
export const SNAPSHOT_FILE_MAX_BYTES = 16 * 1024 * 1024

const snapshotFields = {
  sourceId: sourceIdSchema,
  source: pluginMarketplaceGitSourceSchema,
  marketplaceCommit: z.string().regex(PLUGIN_COMMIT_PATTERN),
  fetchedAt: z.number().finite().nonnegative()
}
// Why two cache keys: builds that predate release records parse `<id>.json` strictly, so a
// downgrade must find only v1-shaped data there and refetch rather than fail.
const legacySnapshotSchema = lazyZodSchema(() =>
  z.strictObject({
    schemaVersion: z.literal(1),
    ...snapshotFields,
    marketplace: pluginMarketplaceSchema
  })
)
export const cachedSnapshotSchema = lazyZodSchema(() =>
  z.strictObject({
    schemaVersion: z.literal(2),
    ...snapshotFields,
    catalogRepository: z.enum(['repository', 'replacement']).optional(),
    marketplace: pluginMarketplaceListingSchema
  })
)

export type PluginMarketplaceCachedSnapshot =
  | z.infer<typeof cachedSnapshotSchema>
  | z.infer<typeof legacySnapshotSchema>

export type CatalogRepositorySlot = NonNullable<
  z.infer<typeof cachedSnapshotSchema>['catalogRepository']
>

export function snapshotRepositorySlot(
  snapshot?: PluginMarketplaceCachedSnapshot | null
): CatalogRepositorySlot {
  return (snapshot?.schemaVersion === 2 && snapshot.catalogRepository) || 'repository'
}

export async function readSnapshotFromDisk(
  sourceId: string,
  path: string,
  legacyPath: string
): Promise<PluginMarketplaceCachedSnapshot | null> {
  return (
    (await readSnapshotFile(path, sourceId, cachedSnapshotSchema)) ??
    (await readSnapshotFile(legacyPath, sourceId, legacySnapshotSchema))
  )
}

async function readSnapshotFile<T extends { sourceId: string }>(
  path: string,
  sourceId: string,
  schema: z.ZodType<T>
): Promise<T | null> {
  try {
    const parsed = schema.parse(JSON.parse(await readBoundedText(path, SNAPSHOT_FILE_MAX_BYTES)))
    if (parsed.sourceId !== sourceId) {
      throw new Error('marketplace snapshot source identity does not match its cache path')
    }
    return parsed
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw new Error(
      `marketplace snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export async function readBoundedText(path: string, limit: number): Promise<string> {
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
