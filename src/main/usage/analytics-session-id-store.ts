import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { UsageCacheSnapshotWriter } from '../usage-cache-snapshot-writer'

const providerSessionIdSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((id) => id.trim().length > 0)
const analyticsSessionIdSchema = z.uuidv4().brand<'AnalyticsSessionId'>()
export type AnalyticsSessionId = z.infer<typeof analyticsSessionIdSchema>
const identityFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(z.tuple([providerSessionIdSchema, analyticsSessionIdSchema]))
  })
  .strict()

/** One owner per file, scoped to a provider's usage store on its execution host. */
export class AnalyticsSessionIdStore {
  private identities: Map<string, AnalyticsSessionId> | null = null
  private pending: Promise<void> = Promise.resolve()
  private writer: UsageCacheSnapshotWriter | null = null

  constructor(private readonly file: string) {}

  async getOrCreate(providerSessionId: string): Promise<AnalyticsSessionId> {
    if (!providerSessionIdSchema.safeParse(providerSessionId).success) {
      throw new Error('Invalid provider session ID')
    }
    // Serialize reads as well as writes so no caller sees an ID before it is durable.
    const operation = this.pending.then(async () => {
      const identities = this.identities ?? (await this.load())
      this.identities = identities
      const existing = identities.get(providerSessionId)
      if (existing) {
        return existing
      }
      const id = analyticsSessionIdSchema.parse(randomUUID())
      const updated = new Map(identities).set(providerSessionId, id)
      this.writer ??= new UsageCacheSnapshotWriter('[analytics-session-id]', () => this.file)
      await this.writer.write(() => JSON.stringify({ schemaVersion: 1, entries: [...updated] }))
      this.identities = updated
      return id
    })
    this.pending = operation.then(
      () => {},
      () => {}
    )
    return operation
  }

  async flush(): Promise<void> {
    await this.pending
    await this.writer?.flush()
  }

  private async load(): Promise<Map<string, AnalyticsSessionId>> {
    let content: string
    try {
      content = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return new Map()
      }
      throw error
    }
    let raw: unknown
    try {
      raw = JSON.parse(content)
    } catch {
      throw new Error('Invalid analytics session identity file')
    }
    const parsed = identityFileSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error('Invalid analytics session identity file')
    }
    const identities = new Map(parsed.data.entries)
    const analyticsIds = new Set(parsed.data.entries.map(([, id]) => id))
    if (identities.size !== parsed.data.entries.length || analyticsIds.size !== identities.size) {
      throw new Error('Duplicate analytics session identity')
    }
    return identities
  }
}
