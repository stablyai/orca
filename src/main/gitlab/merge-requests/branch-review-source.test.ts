import { beforeEach, expect, it, vi } from 'vitest'
const { identity } = vi.hoisted(() => ({ identity: vi.fn() }))
vi.mock('./review-project-identity', () => ({ readReviewProjectIdentity: identity }))
import { resolveReviewSourceProject } from './branch-review-source'
const target = { host: 'gitlab.corp:8443', path: 'team/app' }
const resolve = (urls: string[]) =>
  resolveReviewSourceProject({ repoPath: '/repo', target, urls, localGitOptions: {} })
beforeEach(() => {
  identity.mockReset().mockResolvedValue({ id: 1, path: 'team/app' })
})

it.each([
  'git@gitlab.corp:team/app.git',
  'ssh://git@gitlab.corp:2222/team/app.git',
  'git://gitlab.corp:9418/team/app.git'
])('pins SSH/git transport %s to the established API port', async (url) => {
  await expect(resolve([url])).resolves.toMatchObject({ id: 1, project: target })
  expect(identity).toHaveBeenCalledWith('/repo', target, undefined, {}, undefined)
})
it('preserves the existing SSH hostname alias', async () => {
  await expect(
    resolveReviewSourceProject({
      repoPath: '/repo',
      target: { host: 'gitlab.com', path: 'team/app' },
      urls: ['ssh://git@altssh.gitlab.com:443/team/app.git'],
      localGitOptions: {}
    })
  ).resolves.toMatchObject({ project: { host: 'gitlab.com', path: 'team/app' } })
})
it('retains numeric rename agreement but rejects different participating source projects', async () => {
  await expect(
    resolve(['https://gitlab.corp:8443/old/app.git', 'git@gitlab.corp:team/app.git'])
  ).resolves.toMatchObject({ id: 1 })
  identity
    .mockResolvedValueOnce({ id: 1, path: 'team/app' })
    .mockResolvedValueOnce({ id: 2, path: 'fork/app' })
  await expect(
    resolve(['https://gitlab.corp:8443/team/app.git', 'git@gitlab.corp:fork/app.git'])
  ).rejects.toThrow('multiple projects')
})

it('keeps a participating metadata failure unavailable instead of selecting a sibling', async () => {
  identity.mockRejectedValueOnce(new Error('offline'))
  await expect(
    resolve(['git@gitlab.corp:team/app.git', 'git@gitlab.corp:other/app.git'])
  ).rejects.toThrow('offline')
})
