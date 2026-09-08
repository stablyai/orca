import { expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'
import { mapMRToWorkItem } from '../gitlab/mappers'
const mocks = vi.hoisted(() => ({ git: vi.fn(), item: vi.fn() }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: mocks.git }))
vi.mock('../gitlab/client', () => ({
  getProjectRefForRemote: async () => ({ host: 'gitlab.com', path: 'team/repo' }),
  getWorkItemByProjectRef: mocks.item
}))
vi.mock('../gitlab/gl-utils', () => ({ getGlabKnownHosts: async () => ['gitlab.com'] }))
vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectGitExecOptions: () => ({}),
  getLocalProjectWorktreeGitOptions: () => ({})
}))
vi.mock('./runtime-gitlab-issue-source-remote', () => ({
  resolveRuntimeGitLabIssueSourceRemote: async () => 'origin'
}))
import { resolveRuntimeGitLabWorktreeBase } from './runtime-gitlab-worktree-base'

it.each([
  ['git@gitlab.com:team/repo.git', true],
  ['git@gitlab.com:other/repo.git', false],
  ['git@gitlab.com:team/repo.git\norigin\tgit@gitlab.com:other/repo.git', false]
])('binds same-project GitLab hydration to all execution endpoints %s', async (urls, accepted) => {
  mocks.item.mockResolvedValue(
    mapMRToWorkItem(
      {
        title: 'Review',
        state: 'opened',
        source_branch: 'feature',
        target_branch: 'main',
        source_project_id: 7,
        target_project_id: 7
      },
      'repo',
      { host: 'gitlab.com', path: 'team/repo' }
    )
  )
  mocks.git.mockImplementation(async (args: string[]) => ({
    stdout:
      args[0] === 'remote'
        ? urls
            .split('\n')
            .map((url, index) => `${index === 0 ? 'origin\t' : ''}${url} (push)`)
            .join('\n')
        : 'oid',
    stderr: ''
  }))
  const result = await resolveRuntimeGitLabWorktreeBase(
    { repoSelector: 'repo', mrIid: 42 },
    {
      store: {} as Store,
      resolveRepo: async () => ({ id: 'repo', path: '/repo' }) as Repo
    }
  )
  expect(result).not.toHaveProperty('error')
  if ('error' in result) {
    throw new Error(result.error)
  }
  expect(!!result.pushTarget).toBe(accepted)
  if (accepted) {
    expect(result.pushTarget?.reviewHead).toEqual({
      provider: 'gitlab',
      host: 'gitlab.com',
      repository: 'team/repo',
      branchName: 'feature'
    })
  }
})
