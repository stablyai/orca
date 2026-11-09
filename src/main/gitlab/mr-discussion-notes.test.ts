import { beforeEach, expect, it, vi } from 'vitest'
import type * as GlabApiResponse from './glab-api-response'
const { pages, viewer } = vi.hoisted(() => ({ pages: vi.fn(), viewer: vi.fn() }))
vi.mock('./gl-utils', async () => ({
  ...(await vi.importActual<typeof GlabApiResponse>('./glab-api-response')),
  glabApiWithHeaders: pages,
  glabHostnameArgs: () => [],
  glabRepoExecOptions: () => ({})
}))
vi.mock('./gitlab-auth-and-rate-limit', () => ({ readGlabViewer: viewer }))
import { fetchDiscussionComments } from './mr-discussion-notes'
beforeEach(() => {
  pages.mockReset()
  viewer.mockReset().mockResolvedValue({ username: 'me' })
})
it.each(['mr', 'issue'] as const)(
  'reads newest %s discussions beyond 100 with thread metadata',
  async (type) => {
    pages.mockImplementation(async ([endpoint]: string[]) => {
      const page = Number(new URL(endpoint, 'https://gitlab.com').searchParams.get('page'))
      return {
        body: JSON.stringify(
          Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({
            id: `D${page}-${i}`,
            notes: [
              {
                id: (page - 1) * 100 + i,
                body: 'Review',
                created_at: page === 1 ? '2026-01-01' : '2026-11-08',
                author: { username: 'me' },
                resolvable: true,
                resolved: true,
                position: { new_path: 'a.ts', new_line: 4 }
              }
            ]
          }))
        ),
        headers: { 'x-next-page': page === 1 ? '2' : '' }
      }
    })
    const comments = await fetchDiscussionComments(
      '/repo',
      { host: 'gitlab.com', path: 'g/p' },
      type,
      7
    )
    expect(comments).toHaveLength(101)
    expect(comments.at(-1)).toMatchObject({
      id: 100,
      threadId: 'D2-0',
      isResolved: true,
      path: 'a.ts',
      line: 4,
      viewerDidAuthor: true
    })
    expect(pages).toHaveBeenCalledTimes(2)
    expect(viewer).toHaveBeenCalledTimes(1)
  }
)
it('never presents a successful prefix after a later discussion page fails', async () => {
  pages
    .mockResolvedValueOnce({
      body: JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: String(i) }))),
      headers: { 'x-next-page': '2' }
    })
    .mockRejectedValueOnce(new Error('offline'))
  await expect(
    fetchDiscussionComments('/repo', { host: 'gitlab.com', path: 'g/p' }, 'mr', 7)
  ).rejects.toThrow('incomplete')
})

it.each([100, 1000])('measures complete realistic discussions at %s rows', async (count) => {
  const body = `## Review\n\nPlease preserve the existing owner across reconnects.\n\n\`\`\`typescript\nconst state = await readOwner()\nreturn state.current\n\`\`\`\n\n${'The next request should retain the confirmed state and report incomplete reads. '.repeat(
    20
  )}`
  let rawBytes = 0
  pages.mockImplementation(async ([endpoint]: string[]) => {
    const page = Number(new URL(endpoint, 'https://gitlab.com').searchParams.get('page'))
    const rows = Array.from({ length: Math.min(100, count - (page - 1) * 100) }, (_, i) => ({
      id: `discussion-${page}-${i}`,
      notes: [
        {
          id: (page - 1) * 100 + i,
          body,
          created_at: '2026-11-08T00:00:00Z',
          author: { username: 'me', avatar_url: 'https://gitlab.com/avatar.png' },
          resolvable: true,
          resolved: false,
          position: { new_path: 'src/file.ts', new_line: 17 }
        }
      ]
    }))
    const serialized = JSON.stringify(rows)
    rawBytes += Buffer.byteLength(serialized)
    return {
      body: serialized,
      headers: { 'x-next-page': page * 100 < count ? String(page + 1) : '' }
    }
  })
  const before = process.memoryUsage().heapUsed
  const start = performance.now()
  const result = await fetchDiscussionComments(
    '/repo',
    { host: 'gitlab.com', path: 'g/p' },
    'mr',
    7
  )
  const normalized = performance.now()
  const wireBytes = Buffer.byteLength(JSON.stringify(result))
  console.info('gitlab-review-parity-discussions', {
    count,
    rawBytes,
    wireBytes,
    readParseSortMs: normalized - start,
    serializeMs: performance.now() - normalized,
    heapDeltaBytes: process.memoryUsage().heapUsed - before
  })
  expect(result).toHaveLength(count)
  expect(pages).toHaveBeenCalledTimes(count / 100)
})
