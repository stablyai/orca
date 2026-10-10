import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { RuntimeRepositoryRefQueries } from './runtime-repository-ref-queries'

const { getProvider } = vi.hoisted(() => ({ getProvider: vi.fn() }))
vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProvider: getProvider }))

const repo: Repo = {
  id: 'remote-repo',
  path: '/repo',
  displayName: 'remote',
  badgeColor: 'blue',
  addedAt: 1,
  connectionId: 'ssh-1'
}

describe('qualified refs in repository searches', () => {

  it('keeps folder workspaces outside Git searches', async () => {
    vi.mocked(getSshGitProvider).mockClear()
    const queries = new RuntimeRepositoryRefQueries({
      resolveRepo: async () => ({ ...repo, kind: 'folder' })
    })
    expect(await queries.search('id:remote-repo', 'feature', 2, false)).toEqual({
      refs: [],
      truncated: false
    })
    expect(getSshGitProvider).not.toHaveBeenCalled()
  })
})
