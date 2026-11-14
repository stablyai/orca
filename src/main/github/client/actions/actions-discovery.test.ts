import { afterEach, expect, it, vi } from 'vitest'
import * as remoteProbe from '../../repositories/github-api-repository-remote-probe'
import { getRepoSlug } from '../fetch/repo-slug-upstream'

afterEach(() => vi.restoreAllMocks())
it('keeps verified SSH discovery failures distinct from tolerant PR nulls', async () => {
  const tolerant = vi.spyOn(remoteProbe, 'getOriginGitHubApiRepository').mockResolvedValue(null)
  const verified = vi
    .spyOn(remoteProbe, 'getGitHubApiRepositoryForRemote')
    .mockRejectedValue(new Error('SSH origin unavailable'))
  await expect(getRepoSlug('/remote', 'ssh-a')).resolves.toBeNull()
  await expect(getRepoSlug('/remote', 'ssh-a', { requireVerifiedSshProbe: true })).rejects.toThrow(
    'SSH origin unavailable'
  )
  expect(tolerant).toHaveBeenCalledTimes(1)
  expect(verified).toHaveBeenCalledWith(
    '/remote',
    'origin',
    'ssh-a',
    {},
    {
      requireVerifiedSshProbe: true
    }
  )
})
