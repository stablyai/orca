import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { writeCommunityJson } from './community-json-file'
import type {
  CommunityCatalog,
  CommunityPullRequest,
  CommunitySourceRecord
} from '../../shared/community-catalog'

const date = z.string().refine((value) => Number.isFinite(Date.parse(value)))
const count = z.number().int().nonnegative().nullable()
const url = z
  .string()
  .url()
  .refine((value) => new URL(value).hostname === 'github.com')
const pullRequest = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  displayTitle: z.string(),
  url,
  author: z.string(),
  createdAt: date,
  updatedAt: date,
  isDraft: z.boolean(),
  kind: z.string(),
  area: z.string(),
  comments: count,
  prThumbsUp: count,
  closingIssues: z.array(z.object({ number: z.number(), title: z.string(), url })),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  reviewDecision: z.string().nullable(),
  checkState: z.string().nullable(),
  checkObserved: z.boolean(),
  additions: count,
  deletions: count,
  changedFiles: count,
  imageUrls: z.array(url),
  observedAt: date.optional(),
  state: z.enum(['open', 'closed', 'merged']).optional()
})
const catalogSchema = z.object({
  repository: z.literal('stablyai/orca'),
  capturedAt: date,
  sourceUrl: url,
  pullRequests: z.array(pullRequest).max(20_000),
  groups: z.array(
    z.object({ id: z.string(), label: z.string(), area: z.string(), members: z.array(z.number()) })
  ),
  screenshots: z.record(z.string(), z.object({ src: z.string(), sourceUrl: url })),
  source: z.enum(['bundled', 'github']).optional(),
  lastFullSyncAt: date.optional()
})
const sourceRecord = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: date,
  headSha: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  url,
  fingerprint: z.string()
})
const cacheSchema = z.object({
  version: z.literal(1),
  catalog: catalogSchema,
  history: z.record(z.string(), z.array(sourceRecord).max(30))
})
type History = z.infer<typeof cacheSchema>['history']
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

export class CommunityCatalogStore {
  private catalog: CommunityCatalog | null = null
  private history: History = {}
  constructor(
    private readonly root: string,
    private readonly seedPath?: string
  ) {}

  async load(): Promise<CommunityCatalog | null> {
    try {
      const bytes = await readFile(join(this.root, 'current.json'))
      if (bytes.length > 32 * 1024 * 1024) {
        throw new Error('Community cache exceeds its size limit')
      }
      const saved = cacheSchema.parse(JSON.parse(bytes.toString('utf8')))
      this.catalog = saved.catalog
      this.history = saved.history
      return this.catalog
    } catch (error) {
      if (
        !(error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      ) {
        console.warn('[community] Cache unavailable; refresh to load GitHub data')
      }
    }
    if (!this.seedPath) {
      return null
    }
    try {
      const seed = catalogSchema.parse(JSON.parse(await readFile(this.seedPath, 'utf8')))
      this.catalog = {
        ...seed,
        pullRequests: seed.pullRequests.map((pr) => ({
          ...pr,
          observedAt: pr.observedAt ?? seed.capturedAt
        }))
      }
    } catch {
      this.catalog = null
    }
    return this.catalog
  }

  current(): CommunityCatalog | null {
    return this.catalog
  }

  async captured(number: number): Promise<CommunityPullRequest | null> {
    const current = this.catalog?.pullRequests.find((row) => row.number === number)
    if (current) {
      return current
    }
    const record = this.history[number]?.at(-1)
    if (!record) {
      return null
    }
    let bytes
    try {
      bytes = await readFile(join(this.root, 'source-records', `${record.id}.json`))
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    }
    if (bytes.length > 8 * 1024 * 1024 || digest(bytes.toString('utf8')) !== record.id) {
      throw new Error('The captured PR failed its integrity check.')
    }
    return z.object({ pullRequest }).parse(JSON.parse(bytes.toString('utf8'))).pullRequest
  }

  recent(number: number): CommunitySourceRecord[] {
    return (this.history[number] ?? []).toReversed()
  }

  newerRecords(at: string): { number: number; record: CommunitySourceRecord }[] {
    return Object.entries(this.history).flatMap(([number, records]) => {
      const record = records.at(-1)
      return record && record.observedAt > at ? [{ number: Number(number), record }] : []
    })
  }

  async save(catalog: CommunityCatalog, observations: CommunityPullRequest[]): Promise<void> {
    await mkdir(join(this.root, 'source-records'), { recursive: true, mode: 0o700 })
    const history: History = { ...this.history }
    const previous = new Map(this.catalog?.pullRequests.map((pr) => [pr.number, pr]))
    for (const row of observations) {
      const records = [...(history[row.number] ?? [])]
      const before = previous.get(row.number)
      const versions = records.length === 0 && before ? [before, row] : [row]
      for (const version of versions) {
        const fingerprint = digest(JSON.stringify({ ...version, observedAt: undefined }))
        if (records.at(-1)?.fingerprint === fingerprint) {
          continue
        }
        const observedAt = version.observedAt ?? catalog.capturedAt
        const payload = {
          repository: catalog.repository,
          observedAt,
          previousRecord: records.at(-1)?.id ?? null,
          pullRequest: version
        }
        const id = digest(JSON.stringify(payload))
        await writeCommunityJson(join(this.root, 'source-records', `${id}.json`), payload)
        records.push({
          id,
          observedAt,
          headSha: version.headSha,
          state: version.state ?? 'open',
          url: version.url,
          fingerprint
        })
      }
      history[row.number] = records.slice(-30)
    }
    await writeCommunityJson(join(this.root, 'current.json'), { version: 1, catalog, history })
    this.catalog = catalog
    this.history = history
  }
}
