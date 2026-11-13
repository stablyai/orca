import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { CommunityActivity, CommunityRelease } from '../../shared/community-operations'
import type { CommunityGitHubSource } from './community-github-source'
import { communityReviewFacts } from './community-review-facts'
import { writeCommunityJson } from './community-json-file'
const release = z.object({
  tag_name: z.string(),
  name: z.string().nullable(),
  html_url: z.string().url(),
  published_at: z.string().nullable(),
  body: z.string().nullable(),
  draft: z.boolean(),
  prerelease: z.boolean()
})
const pr = z.object({
  number: z.number(),
  node_id: z.string(),
  author_association: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  created_at: z.string(),
  state: z.string(),
  merged_at: z.string().nullable()
})
const collaborator = z.object({
  login: z.string(),
  role_name: z.string().optional(),
  permissions: z
    .object({ admin: z.boolean().optional(), maintain: z.boolean().optional() })
    .optional()
})
const cache = z.object({ version: z.literal(1), at: z.string(), data: z.unknown() })
const activitySchema = z.object({
  capturedAt: z.string(),
  since: z.string(),
  cutoff: z.string(),
  complete: z.boolean(),
  rows: z.array(
    z.object({
      number: z.number(),
      author: z.string(),
      authorAssociation: z.string(),
      memberReviewed: z.boolean().nullable(),
      memberApproved: z.boolean().nullable(),
      createdAt: z.string(),
      merged: z.boolean(),
      closed: z.boolean(),
      reviewed: z.boolean().nullable(),
      approved: z.boolean().nullable(),
      maintainerReviewed: z.boolean().nullable(),
      maintainerApproved: z.boolean().nullable()
    })
  ),
  maintainers: z.array(z.string()).nullable(),
  roleError: z.string().nullable()
})
export class CommunityPublishedData {
  private pending = new Map<string, Promise<unknown>>()
  constructor(
    private readonly root: string,
    private readonly source: CommunityGitHubSource
  ) {}
  private async cached<T>(name: string, load: () => Promise<T>, schema: z.ZodType<T>): Promise<T> {
    const key = `${name}-${(await this.source.authenticated()) ? 'authenticated' : 'public'}`
    let saved: z.infer<typeof cache> | null = null
    try {
      const bytes = await readFile(join(this.root, `${key}.json`))
      if (bytes.length < 16 * 1024 * 1024) {
        saved = cache.parse(JSON.parse(bytes.toString('utf8')))
      }
      if (saved && Date.now() - Date.parse(saved.at) < 15 * 60_000) {
        return schema.parse(saved.data)
      }
    } catch {}
    const existing = this.pending.get(key)
    if (existing) {
      return schema.parse(await existing)
    }
    const request = (async () => {
      try {
        const data = await load()
        await mkdir(this.root, { recursive: true, mode: 0o700 })
        await writeCommunityJson(join(this.root, `${key}.json`), {
          version: 1,
          at: new Date().toISOString(),
          data
        })
        return data
      } catch (error) {
        if (saved) {
          return schema.parse(saved.data)
        }
        throw error
      } finally {
        this.pending.delete(key)
      }
    })()
    this.pending.set(key, request)
    return request
  }
  releases(): Promise<CommunityRelease[]> {
    return this.cached(
      'releases',
      async () =>
        z
          .array(release)
          .parse(await this.source.request('releases?per_page=30', new AbortController().signal))
          .filter((row) => !row.draft && row.published_at)
          .map((row) => ({
            tag: row.tag_name,
            name: row.name ?? row.tag_name,
            url: row.html_url,
            publishedAt: row.published_at!,
            body: row.body ?? '',
            prerelease: row.prerelease
          })),
      z.array(
        z.object({
          tag: z.string(),
          name: z.string(),
          url: z.string().url(),
          publishedAt: z.string(),
          body: z.string(),
          prerelease: z.boolean()
        })
      )
    )
  }
  activity(): Promise<CommunityActivity> {
    return this.cached('activity-v2', () => this.captureActivity(), activitySchema)
  }
  private async captureActivity(): Promise<CommunityActivity> {
    const signal = new AbortController().signal
    const capturedAt = new Date().toISOString()
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString()
    const rows: CommunityActivity['rows'] = []
    const nodeIds: string[] = []
    const seen = new Set<number>()
    let complete = false
    for (let page = 1; page <= 20; page++) {
      const batch = z
        .array(pr)
        .parse(
          await this.source.request(
            `pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
            signal
          )
        )
      const included = batch.filter((row) => {
        if (row.created_at < since || row.created_at > capturedAt || seen.has(row.number)) {
          return false
        }
        seen.add(row.number)
        return true
      })
      nodeIds.push(...included.map((row) => row.node_id))
      rows.push(
        ...included.map((row) => ({
          number: row.number,
          author: row.user?.login ?? 'Deleted account',
          authorAssociation: row.author_association,
          memberReviewed: null,
          memberApproved: null,
          createdAt: row.created_at,
          merged: row.merged_at !== null,
          closed: row.state === 'closed',
          reviewed: null,
          approved: null,
          maintainerReviewed: null,
          maintainerApproved: null
        }))
      )
      if (batch.length < 100 || batch.some((row) => row.created_at < since)) {
        complete = true
        break
      }
    }
    let maintainers: string[] | null = null
    let roleError: string | null = null
    try {
      const team = z
        .array(collaborator)
        .parse(await this.source.request('collaborators?affiliation=all&per_page=100', signal))
      if (team.length === 100) {
        throw new Error('The maintainer list needs another page.')
      }
      maintainers = team
        .filter(
          (row) =>
            row.permissions?.admin ||
            row.permissions?.maintain ||
            row.role_name === 'maintain' ||
            row.role_name === 'admin'
        )
        .map((row) => row.login)
    } catch {
      roleError =
        'GitHub did not provide the complete maintainer-role list. Group comparisons need this evidence.'
    }
    if (await this.source.authenticated()) {
      try {
        const facts = await communityReviewFacts(this.source, nodeIds, maintainers, signal)
        for (let i = 0; i < rows.length; i++) {
          const fact = facts.get(rows[i].number)
          if (fact) {
            rows[i] = { ...rows[i], ...fact }
          }
        }
      } catch {
        roleError = `${roleError ?? ''} Review evidence could not be completed.`.trim()
      }
    }
    return {
      capturedAt,
      since,
      cutoff: rows.at(-1)?.createdAt ?? since,
      complete,
      rows,
      maintainers,
      roleError
    }
  }
}
