import { beforeEach, describe, expect, it, vi } from 'vitest'

const ghExecFileAsync = vi.fn()

vi.mock('../git/runner', () => ({ ghExecFileAsync }))

const { listAuthenticatedGitHubRepositories } = await import('./repository-catalog')

describe('listAuthenticatedGitHubRepositories', () => {
  beforeEach(() => {
    ghExecFileAsync.mockReset()
  })

  it('lists repositories available to the authenticated account', async () => {
    ghExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify([
        {
          full_name: 'stablyai/orca',
          description: 'Agent workspace',
          private: false,
          updated_at: '2026-07-18T20:00:00Z',
          clone_url: 'https://github.com/stablyai/orca.git',
          ssh_url: 'git@github.com:stablyai/orca.git'
        }
      ]),
      stderr: ''
    })

    await expect(listAuthenticatedGitHubRepositories()).resolves.toEqual([
      {
        nameWithOwner: 'stablyai/orca',
        description: 'Agent workspace',
        isPrivate: false,
        updatedAt: '2026-07-18T20:00:00Z',
        httpsUrl: 'https://github.com/stablyai/orca.git',
        sshUrl: 'git@github.com:stablyai/orca.git'
      }
    ])
    expect(ghExecFileAsync).toHaveBeenCalledWith([
      'api',
      'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'
    ])
  })

  it('drops malformed repository rows', async () => {
    ghExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify([{ full_name: 'missing/urls' }, null]),
      stderr: ''
    })

    await expect(listAuthenticatedGitHubRepositories()).resolves.toEqual([])
  })
})
