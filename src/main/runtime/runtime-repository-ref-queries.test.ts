import { describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { RuntimeRepositoryRefQueries } from './runtime-repository-ref-queries'

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
    const queries = new RuntimeRepositoryRefQueries({
      resolveRepo: async () => ({ ...repo, kind: 'folder' })
    })
    expect(await queries.search('id:remote-repo', 'feature', 2, false)).toEqual({
      refs: [],
      truncated: false
    })
  })
})
