import type {
  GitignoreTemplateCache,
  GitignoreTemplateCatalogResult,
  GitignoreTemplateMetadata,
  GitignoreTemplateResult
} from '../../shared/gitignore-templates'

const CATALOG_URL = 'https://api.github.com/repos/github/gitignore/contents'
const RAW_BASE_URL = 'https://raw.githubusercontent.com/github/gitignore/main'
const CACHE_TTL_MS = 60 * 60 * 1000
const TEMPLATE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9+._-]{0,99}$/

type TemplateCacheStore = {
  read(): Promise<GitignoreTemplateCache | null>
  write(cache: GitignoreTemplateCache): Promise<void>
}

type GitHubTemplateServiceOptions = {
  fetch: typeof globalThis.fetch
  cache: TemplateCacheStore
  now?: () => number
}

type GitHubContentEntry = { name?: unknown; type?: unknown }

export class GitignoreTemplateServiceError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'rate-limit' | 'invalid-response' | 'invalid-template'
  ) {
    super(message)
    this.name = 'GitignoreTemplateServiceError'
  }
}

function emptyCache(): GitignoreTemplateCache {
  return { templates: {} }
}

function isFresh(fetchedAt: number, now: number): boolean {
  return now - fetchedAt < CACHE_TTL_MS
}

function normalizeTemplateName(name: string): string {
  const normalized = name.endsWith('.gitignore') ? name.slice(0, -'.gitignore'.length) : name
  if (!TEMPLATE_NAME_PATTERN.test(normalized)) {
    throw new GitignoreTemplateServiceError('Invalid gitignore template name.', 'invalid-template')
  }
  return normalized
}

function parseCatalog(value: unknown): GitignoreTemplateMetadata[] {
  if (!Array.isArray(value)) {
    throw new GitignoreTemplateServiceError('GitHub returned an invalid template catalog.', 'invalid-response')
  }
  return (value as GitHubContentEntry[])
    .filter(
      (entry): entry is { name: string; type: string } =>
        entry.type === 'file' && typeof entry.name === 'string' && entry.name.endsWith('.gitignore')
    )
    .map(({ name }) => ({ name: name.slice(0, -'.gitignore'.length), filename: name }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function responseError(response: Response): GitignoreTemplateServiceError {
  if (response.status === 403 || response.status === 429) {
    return new GitignoreTemplateServiceError(
      'GitHub template requests are rate limited. Try again later.',
      'rate-limit'
    )
  }
  return new GitignoreTemplateServiceError(
    `GitHub template request failed (${response.status}).`,
    'network'
  )
}

export class GitHubGitignoreTemplateService {
  private readonly now: () => number

  constructor(private readonly options: GitHubTemplateServiceOptions) {
    this.now = options.now ?? Date.now
  }

  async list(signal?: AbortSignal): Promise<GitignoreTemplateCatalogResult> {
    const cache = (await this.options.cache.read()) ?? emptyCache()
    if (cache.catalog && isFresh(cache.catalog.fetchedAt, this.now())) {
      return { templates: cache.catalog.templates, stale: false }
    }

    try {
      const response = await this.options.fetch(CATALOG_URL, {
        signal,
        headers: { Accept: 'application/vnd.github+json' }
      })
      if (!response.ok) {
        throw responseError(response)
      }
      const templates = parseCatalog(await response.json())
      cache.catalog = { fetchedAt: this.now(), templates }
      await this.options.cache.write(cache)
      return { templates, stale: false }
    } catch (error) {
      if (signal?.aborted) {
        throw error
      }
      if (cache.catalog) {
        return { templates: cache.catalog.templates, stale: true }
      }
      throw error instanceof GitignoreTemplateServiceError
        ? error
        : new GitignoreTemplateServiceError('Could not reach GitHub templates.', 'network')
    }
  }

  async get(name: string, signal?: AbortSignal): Promise<GitignoreTemplateResult> {
    const normalized = normalizeTemplateName(name)
    const cache = (await this.options.cache.read()) ?? emptyCache()
    const cached = cache.templates[normalized]
    const template = { name: normalized, filename: `${normalized}.gitignore` }
    if (cached && isFresh(cached.fetchedAt, this.now())) {
      return { template, content: cached.content, stale: false }
    }

    try {
      const response = await this.options.fetch(
        `${RAW_BASE_URL}/${encodeURIComponent(template.filename)}`,
        { signal }
      )
      if (!response.ok) {
        throw responseError(response)
      }
      const content = await response.text()
      cache.templates[normalized] = { fetchedAt: this.now(), content }
      await this.options.cache.write(cache)
      return { template, content, stale: false }
    } catch (error) {
      if (signal?.aborted) {
        throw error
      }
      if (cached) {
        return { template, content: cached.content, stale: true }
      }
      throw error instanceof GitignoreTemplateServiceError
        ? error
        : new GitignoreTemplateServiceError('Could not reach GitHub templates.', 'network')
    }
  }
}

export { CACHE_TTL_MS }
