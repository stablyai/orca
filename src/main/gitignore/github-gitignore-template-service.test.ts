import { describe, expect, it, vi } from 'vitest'
import type { GitignoreTemplateCache } from '../../shared/gitignore-templates'
import { CACHE_TTL_MS, GitHubGitignoreTemplateService } from './github-gitignore-template-service'
import type { GitignoreTemplateServiceError } from './github-gitignore-template-service'

function createCache(initial: GitignoreTemplateCache = { templates: {} }) {
  let value = structuredClone(initial)
  return {
    read: vi.fn(async () => structuredClone(value)),
    write: vi.fn(async (next: GitignoreTemplateCache) => {
      value = structuredClone(next)
    })
  }
}

describe('GitHubGitignoreTemplateService', () => {
  it('caches the catalog for one hour', async () => {
    const cache = createCache()
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify([{ name: 'Node.gitignore', type: 'file' }]), { status: 200 })
    )
    const service = new GitHubGitignoreTemplateService({ fetch, cache, now: () => 10 })

    expect(await service.list()).toEqual({
      templates: [{ name: 'Node', filename: 'Node.gitignore' }],
      stale: false
    })
    expect(await service.list()).toEqual({
      templates: [{ name: 'Node', filename: 'Node.gitignore' }],
      stale: false
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('returns the last catalog when refresh fails', async () => {
    const cache = createCache({
      templates: {},
      catalog: { fetchedAt: 1, templates: [{ name: 'Rust', filename: 'Rust.gitignore' }] }
    })
    const service = new GitHubGitignoreTemplateService({
      fetch: vi.fn(async () => {
        throw new TypeError('offline')
      }),
      cache,
      now: () => CACHE_TTL_MS + 2
    })

    expect(await service.list()).toEqual({
      templates: [{ name: 'Rust', filename: 'Rust.gitignore' }],
      stale: true
    })
  })

  it('returns a stale selected template when offline', async () => {
    const cache = createCache({ templates: { Go: { fetchedAt: 1, content: 'bin/\n' } } })
    const service = new GitHubGitignoreTemplateService({
      fetch: vi.fn(async () => {
        throw new TypeError('offline')
      }),
      cache,
      now: () => CACHE_TTL_MS + 2
    })

    expect(await service.get('Go')).toMatchObject({ content: 'bin/\n', stale: true })
  })

  it('reports rate limits without a cache', async () => {
    const service = new GitHubGitignoreTemplateService({
      fetch: vi.fn(async () => new Response('', { status: 429 })),
      cache: createCache()
    })

    await expect(service.list()).rejects.toMatchObject({
      kind: 'rate-limit'
    } satisfies Partial<GitignoreTemplateServiceError>)
  })

  it('rejects template names that could escape the GitHub path', async () => {
    const service = new GitHubGitignoreTemplateService({ fetch: vi.fn(), cache: createCache() })
    await expect(service.get('../secret')).rejects.toMatchObject({ kind: 'invalid-template' })
  })
})
