import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/types'

const issueMocks = vi.hoisted(() => ({
  createGitHubIssue: vi.fn(),
  createLinearIssue: vi.fn()
}))

vi.mock('../github/issues', () => ({
  createIssue: issueMocks.createGitHubIssue
}))

vi.mock('../linear/issues', () => ({
  createIssue: issueMocks.createLinearIssue
}))

import { OrcaRuntimeService } from './orca-runtime'

const gitRepo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#fff',
  addedAt: 1,
  kind: 'git',
  connectionId: 'ssh-1',
  issueSourcePreference: 'upstream'
}

const folderRepo: Repo = {
  id: 'folder-1',
  path: '/folder',
  displayName: 'folder',
  badgeColor: '#000',
  addedAt: 2,
  kind: 'folder'
}

function makeRuntime(repos: Repo[] = [gitRepo]): OrcaRuntimeService {
  return new OrcaRuntimeService({
    getRepos: () => repos
  } as never)
}

describe('OrcaRuntimeService issue creation', () => {
  beforeEach(() => {
    issueMocks.createGitHubIssue.mockReset()
    issueMocks.createLinearIssue.mockReset()
  })

  it('creates GitHub issues through a registered git repo selector', async () => {
    issueMocks.createGitHubIssue.mockResolvedValueOnce({
      ok: true,
      number: 42,
      url: 'https://github.com/o/r/issues/42'
    })

    await expect(
      makeRuntime().createIssue({
        provider: 'github',
        repo: 'id:repo-1',
        title: ' New bug ',
        body: 'Steps'
      })
    ).resolves.toEqual({
      provider: 'github',
      number: 42,
      url: 'https://github.com/o/r/issues/42',
      repo: {
        id: 'repo-1',
        path: '/repo',
        displayName: 'repo'
      }
    })
    expect(issueMocks.createGitHubIssue).toHaveBeenCalledWith(
      '/repo',
      'New bug',
      'Steps',
      'upstream',
      'ssh-1'
    )
  })

  it('rejects unsupported providers before issue creation', async () => {
    await expect(
      makeRuntime().createIssue({
        provider: 'gitlab',
        repo: 'id:repo-1',
        title: 'Bug',
        body: 'Steps'
      } as never)
    ).rejects.toThrow('Unsupported issue provider')
    expect(issueMocks.createGitHubIssue).not.toHaveBeenCalled()
    expect(issueMocks.createLinearIssue).not.toHaveBeenCalled()
  })

  it('rejects blank titles and bodies before issue creation', async () => {
    await expect(
      makeRuntime().createIssue({
        provider: 'github',
        repo: 'id:repo-1',
        title: ' ',
        body: 'Steps'
      })
    ).rejects.toThrow('Title is required')
    await expect(
      makeRuntime().createIssue({
        provider: 'github',
        repo: 'id:repo-1',
        title: 'Bug',
        body: ' '
      })
    ).rejects.toThrow('Body is required')
    await expect(
      makeRuntime().createIssue({
        provider: 'github',
        repo: 'id:repo-1',
        title: 'Bug'
      } as never)
    ).rejects.toThrow('Body is required')
    expect(issueMocks.createGitHubIssue).not.toHaveBeenCalled()
  })

  it('rejects missing and mismatched provider targets before issue creation', async () => {
    await expect(
      makeRuntime().createIssue({
        provider: 'github',
        title: 'Bug',
        body: 'Steps'
      })
    ).rejects.toThrow('GitHub issue creation requires --repo')
    await expect(
      makeRuntime().createIssue({
        provider: 'linear',
        title: 'Bug',
        body: 'Steps'
      })
    ).rejects.toThrow('Linear issue creation requires --team')
    await expect(
      makeRuntime().createIssue({
        provider: 'github',
        repo: 'id:repo-1',
        team: 'team-1',
        title: 'Bug',
        body: 'Steps'
      })
    ).rejects.toThrow('GitHub issue creation uses --repo, not --team')
    await expect(
      makeRuntime().createIssue({
        provider: 'linear',
        repo: 'id:repo-1',
        team: 'team-1',
        title: 'Bug',
        body: 'Steps'
      })
    ).rejects.toThrow('Linear issue creation uses --team, not --repo')
    expect(issueMocks.createGitHubIssue).not.toHaveBeenCalled()
    expect(issueMocks.createLinearIssue).not.toHaveBeenCalled()
  })

  it('rejects GitHub issue creation for folder-mode repos', async () => {
    await expect(
      makeRuntime([folderRepo]).createIssue({
        provider: 'github',
        repo: 'id:folder-1',
        title: 'Bug',
        body: 'Steps'
      })
    ).rejects.toThrow('GitHub issue creation requires a git repo.')
    expect(issueMocks.createGitHubIssue).not.toHaveBeenCalled()
  })

  it('creates Linear issues with a required team ID', async () => {
    issueMocks.createLinearIssue.mockResolvedValueOnce({
      ok: true,
      id: 'lin-1',
      identifier: 'ENG-42',
      url: 'https://linear.app/team/issue/ENG-42'
    })

    await expect(
      makeRuntime().createIssue({
        provider: 'linear',
        team: ' team-1 ',
        title: ' Follow up ',
        body: 'Context'
      })
    ).resolves.toEqual({
      provider: 'linear',
      id: 'lin-1',
      identifier: 'ENG-42',
      url: 'https://linear.app/team/issue/ENG-42'
    })
    expect(issueMocks.createLinearIssue).toHaveBeenCalledWith('team-1', 'Follow up', 'Context')
  })
})
