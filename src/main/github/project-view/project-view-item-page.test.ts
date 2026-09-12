import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn()
}))

vi.mock('./internals', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
  extractExecError: vi.fn(),
  ghExecFileAsync: ghExecFileAsyncMock,
  noteRepositoryRateLimitSpend: vi.fn(),
  projectGhExecOptions: () => ({}),
  projectHostAuthenticationError: vi.fn().mockResolvedValue(null),
  repositoryRateLimitGuard: vi.fn().mockReturnValue({ blocked: false })
}))

import { fetchItemsPageWithRaw } from './project-view-item-page'

function itemsStdout(): string {
  return JSON.stringify({
    data: {
      organization: {
        projectV2: {
          items: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: []
          }
        }
      }
    }
  })
}

describe('fetchItemsPageWithRaw search-index query', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: itemsStdout(), stderr: '' })
  })

  it('omits items(query:) for empty and whitespace filters', async () => {
    for (const query of ['', '   ']) {
      ghExecFileAsyncMock.mockClear()
      await fetchItemsPageWithRaw({
        owner: 'acme',
        ownerType: 'organization',
        projectNumber: 1,
        query,
        first: 100,
        after: null,
        includeParent: false
      })
      const args = ghExecFileAsyncMock.mock.calls[0]?.[0] as string[]
      const graphql = args.find((part) => part.startsWith('query=')) ?? ''
      expect(graphql).not.toContain('query:$q')
      expect(args).not.toContainEqual(expect.stringMatching(/^q=/))
    }
  })

  it('keeps items(query:) for a real view filter', async () => {
    await fetchItemsPageWithRaw({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 1,
      query: 'status:Todo',
      first: 100,
      after: null,
      includeParent: false
    })
    const args = ghExecFileAsyncMock.mock.calls[0]?.[0] as string[]
    const graphql = args.find((part) => part.startsWith('query=')) ?? ''
    expect(graphql).toContain('query:$q')
    expect(args).toContain('q=status:Todo')
  })
})
