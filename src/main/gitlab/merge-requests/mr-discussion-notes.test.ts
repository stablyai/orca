import { beforeEach, expect, it, vi } from 'vitest'

const { pages, viewer } = vi.hoisted(() => ({ pages: vi.fn(), viewer: vi.fn() }))
vi.mock('../requests/glab-request-admission', () => ({
  glabApiWithHeaders: pages
}))

vi.mock('../projects/gitlab-project-ref-resolution', () => ({
  glabHostnameArgs: () => [],
  glabRepoExecOptions: () => ({})
}))
vi.mock('../requests/gitlab-auth-and-rate-limit', () => ({ readGlabViewer: viewer }))
import { fetchDiscussionComments } from './mr-discussion-notes'
beforeEach(() => {
  pages.mockReset()
  viewer.mockReset().mockResolvedValue({ username: 'me' })
})

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
