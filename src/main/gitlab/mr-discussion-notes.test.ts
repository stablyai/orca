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
