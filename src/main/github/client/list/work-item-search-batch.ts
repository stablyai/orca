import { z } from 'zod'
import { createHash } from 'node:crypto'
import { BoundedMap } from '../../../../shared/bounded-map'
import { runCoalescedProbe, type CoalescedProbes } from '../../../git/coalesced-probe'
import { createGhRateLimitBlockedError } from '../../../git/gh-rate-limit-breaker'
import { extractExecError, ghExecFileAsync } from '../../gh-utils'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../rate-limit'
import type { GitHubRepoExecOptions } from '../../github-api-repository'

const envelopeSchema = z.object({
  data: z.record(z.string(), z.unknown()).nullish(),
  errors: z
    .array(
      z.object({
        message: z.string().optional(),
        path: z.array(z.union([z.string(), z.number()])).optional()
      })
    )
    .optional()
})

type Envelope = z.infer<typeof envelopeSchema>

type SearchRequest = {
  search: string
  first: number
  after?: string
  selection: string
  options: GitHubRepoExecOptions
  environment?: NodeJS.ProcessEnv
  noCache?: boolean
}

type PendingSearch = {
  request: SearchRequest
  environment: NodeJS.ProcessEnv
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

export const WORK_ITEM_SEARCH_CACHE_MS = 120_000

const MAX_BATCH = 10

// Leave room for Windows argv escaping and the gh executable path.
const MAX_BATCH_QUERY_CHARS = 12_000

const pending = new Map<string, PendingSearch[]>()

type SearchResponse<T> = { at: number; value: T }

const inFlight: CoalescedProbes<SearchResponse<unknown>> = new Map()

const responses = new BoundedMap<string, { at: number; value: unknown }>({
  maxEntries: 512,
  maxBytes: 16 * 1024 * 1024,
  sizeOf: (value, key) => Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value))
})

export function workItemSearchScope(
  options: GitHubRepoExecOptions,
  environment: NodeJS.ProcessEnv = options.env ?? process.env
): string {
  // gh wrappers and credential selection can depend on cwd and the inherited environment.
  return createHash('sha256')
    .update(
      JSON.stringify([
        options,
        process.cwd(),
        Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))
      ])
    )
    .digest('hex')
}

export function requestWorkItemSearch<T>(request: SearchRequest): Promise<SearchResponse<T>> {
  const environment = { ...(request.environment ?? request.options.env ?? process.env) }
  const scope = workItemSearchScope(request.options, environment)

  const key = JSON.stringify([
    scope,
    request.search,
    request.first,
    request.after,
    request.selection
  ])

  const cached = request.noCache ? undefined : responses.get(key)

  if (cached && Date.now() - cached.at < WORK_ITEM_SEARCH_CACHE_MS) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The cache key includes the complete selection; callers validate its response shape.
    return Promise.resolve(cached as SearchResponse<T>)
  }

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Coalescing uses the complete selection key; callers validate the selected response.
  return runCoalescedProbe(inFlight, `${key}:${Boolean(request.noCache)}`, async (ownsKey) => {
    const value = await new Promise<unknown>((resolve, reject) => {
      const batchKey = `${scope}:${Boolean(request.noCache)}`
      let queue = pending.get(batchKey)

      if (!queue) {
        queue = []
        pending.set(batchKey, queue)
        setTimeout(() => flushSearches(batchKey), 0)
      }

      queue.push({ request, environment, resolve, reject })
    })

    const response = { at: Date.now(), value }

    if (!request.noCache && ownsKey()) {
      responses.set(key, response)
    }

    return response
  }) as Promise<SearchResponse<T>>
}

function flushSearches(key: string): void {
  const queue = pending.get(key)
  pending.delete(key)

  if (!queue) {
    return
  }

  let batch: PendingSearch[] = []
  let characters = 0

  for (const entry of queue) {
    const size = searchSelection(entry.request, batch.length).length

    if (batch.length && (batch.length === MAX_BATCH || characters + size > MAX_BATCH_QUERY_CHARS)) {
      void executeSearches(batch)
      batch = []
      characters = 0
    }

    batch.push(entry)
    characters += size
  }

  if (batch.length) {
    void executeSearches(batch)
  }
}

function searchSelection(request: SearchRequest, index: number): string {
  const after = request.after ? `, after: ${JSON.stringify(request.after)}` : ''

  return `r${index}: search(type: ISSUE, query: ${JSON.stringify(request.search)}, first: ${request.first}${after}) { ${request.selection} }`
}

async function executeSearches(batch: PendingSearch[]): Promise<void> {
  const { options } = batch[0].request

  try {
    const guard = repositoryRateLimitGuard(options, 'graphql', options)

    if (guard.blocked) {
      throw createGhRateLimitBlockedError('graphql', guard.resetAt * 1000)
    }

    const selections = batch.map(({ request }, index) => searchSelection(request, index))
    const query = `query { ${selections.join('\n')} rateLimit { cost } }`
    // One response cache owns age; a gh cache hit would otherwise renew an older response.
    const args = ['api', 'graphql', '-f', `query=${query}`]
    let envelope: Envelope

    try {
      const { stdout } = await ghExecFileAsync(args, {
        ...options,
        env: batch[0].environment,
        idempotent: true
      })

      envelope = envelopeSchema.parse(JSON.parse(stdout))
    } catch (error) {
      const { stdout } = extractExecError(error)

      if (!stdout) {
        throw error
      }

      try {
        envelope = envelopeSchema.parse(JSON.parse(stdout))
      } catch {
        throw error
      }

      if (!envelope.data || !envelope.errors?.length) {
        throw error
      }
    }

    const rateLimit = envelope.data?.rateLimit

    const cost =
      rateLimit && typeof rateLimit === 'object' && 'cost' in rateLimit ? rateLimit.cost : undefined

    noteRepositoryRateLimitSpend(
      options,
      'graphql',
      typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : batch.length,
      options
    )

    for (const [index, entry] of batch.entries()) {
      const alias = `r${index}`

      const errors = envelope.errors?.filter(
        (error) => !error.path?.length || error.path[0] === alias
      )

      const value = envelope.data?.[alias]

      if (errors?.length || value === undefined || value === null) {
        entry.reject(
          new Error(
            errors?.map((error) => error.message).join('; ') ||
              'GitHub search response missing data'
          )
        )
      } else {
        entry.resolve(value)
      }
    }
  } catch (error) {
    for (const entry of batch) {
      entry.reject(error)
    }
  }
}
