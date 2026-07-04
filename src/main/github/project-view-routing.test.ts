import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock, gitExecFileAsyncMock, rateLimitGuardMock, noteRateLimitSpendMock } =
  vi.hoisted(() => ({
    ghExecFileAsyncMock: vi.fn(),
    gitExecFileAsyncMock: vi.fn(),
    rateLimitGuardMock: vi.fn(() => ({ blocked: false })),
    noteRateLimitSpendMock: vi.fn()
  }))

vi.mock('../git/runner', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  gitExecFileAsync: gitExecFileAsyncMock,
  extractExecError: (err: unknown) => ({
    stderr: err && typeof err === 'object' && 'stderr' in err ? String(err.stderr) : '',
    stdout: err && typeof err === 'object' && 'stdout' in err ? String(err.stdout) : ''
  })
}))

vi.mock('./rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock
}))

import { _resetOwnerRepoCache } from './gh-utils'
import {
  _resetProjectViewCachesForTests,
  listAccessibleProjects,
  resolveProjectRef,
  updateIssueBySlug,
  updateProjectItemFieldValue
} from './project-view'

function discoveryResponses(): { stdout: string; stderr: string }[] {
  return [
    {
      stdout: JSON.stringify({
        data: {
          viewer: {
            login: 'octocat',
            projectsV2: { pageInfo: { hasNextPage: false }, nodes: [] }
          }
        }
      }),
      stderr: ''
    },
    {
      stdout: JSON.stringify({
        data: {
          viewer: {
            organizations: { pageInfo: { hasNextPage: false }, nodes: [] }
          }
        }
      }),
      stderr: ''
    }
  ]
}

describe('GitHub Project gh routing', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRateLimitSpendMock.mockReset()
    _resetOwnerRepoCache()
    _resetProjectViewCachesForTests()
  })

  it('passes --hostname for GitHub Enterprise repo targets', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('upstream missing'))
      .mockResolvedValueOnce({ stdout: 'https://ghe.acme.internal/acme/orca.git\n' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce(discoveryResponses()[0])
      .mockResolvedValueOnce(discoveryResponses()[1])

    await expect(listAccessibleProjects({ repoPath: '/repo' })).resolves.toMatchObject({
      ok: true
    })

    expect(ghExecFileAsyncMock).toHaveBeenCalled()
    for (const [argv, options] of ghExecFileAsyncMock.mock.calls) {
      expect(argv).toEqual(expect.arrayContaining(['--hostname', 'ghe.acme.internal']))
      expect(options).toMatchObject({ cwd: '/repo' })
    }
  })

  it('does not pass known non-GitHub remote hosts as gh api hostnames', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('upstream missing'))
      .mockResolvedValueOnce({ stdout: 'git@gitlab.com:acme/orca.git\n' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce(discoveryResponses()[0])
      .mockResolvedValueOnce(discoveryResponses()[1])

    await expect(listAccessibleProjects({ repoPath: '/repo' })).resolves.toMatchObject({
      ok: true
    })

    const firstArgv = ghExecFileAsyncMock.mock.calls[0][0] as string[]
    expect(firstArgv).not.toContain('--hostname')
    expect(ghExecFileAsyncMock.mock.calls[0][1]).toMatchObject({ cwd: '/repo' })
  })

  it('passes --hostname for Project field and slug mutations', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('upstream missing'))
      .mockResolvedValueOnce({ stdout: 'https://ghe.acme.internal/acme/orca.git\n' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ data: { updateProjectV2ItemFieldValue: {} } }),
      stderr: ''
    })

    await expect(
      updateProjectItemFieldValue({
        repoPath: '/repo',
        projectId: 'PVT_project',
        itemId: 'PVTI_item',
        fieldId: 'PVTF_field',
        value: { kind: 'text', text: 'Ready' }
      })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['--hostname', 'ghe.acme.internal'])
    )

    ghExecFileAsyncMock.mockClear()
    gitExecFileAsyncMock.mockClear()
    _resetOwnerRepoCache()
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('upstream missing'))
      .mockResolvedValueOnce({ stdout: 'https://ghe.acme.internal/acme/orca.git\n' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '{}', stderr: '' })

    await expect(
      updateIssueBySlug({
        repoPath: '/repo',
        owner: 'acme',
        repo: 'orca',
        number: 12,
        updates: { title: 'New title' }
      })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['--hostname', 'ghe.acme.internal'])
    )
  })

  it('does not reuse owner-type probes across github.com and GHES routes', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('upstream missing'))
      .mockResolvedValueOnce({ stdout: 'https://github.com/acme/orca.git\n' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ data: { organization: null } }),
        stderr: ''
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ data: { user: { login: 'acme' } } }),
        stderr: ''
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: { user: { projectV2: { id: 'PVT_public', title: 'Public project' } } }
        }),
        stderr: ''
      })

    await expect(resolveProjectRef({ repoPath: '/github-repo', input: 'acme/2' })).resolves.toEqual(
      {
        ok: true,
        owner: 'acme',
        ownerType: 'user',
        number: 2,
        title: 'Public project'
      }
    )

    gitExecFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('upstream missing'))
      .mockResolvedValueOnce({ stdout: 'https://ghe.acme.internal/acme/orca.git\n' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ data: { organization: { login: 'acme' } } }),
        stderr: ''
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            organization: { projectV2: { id: 'PVT_enterprise', title: 'Enterprise project' } }
          }
        }),
        stderr: ''
      })

    await expect(resolveProjectRef({ repoPath: '/ghe-repo', input: 'acme/2' })).resolves.toEqual({
      ok: true,
      owner: 'acme',
      ownerType: 'organization',
      number: 2,
      title: 'Enterprise project'
    })

    const firstGheArgv = ghExecFileAsyncMock.mock.calls[0][0] as string[]
    const firstGheQuery = firstGheArgv.find((arg) => arg.startsWith('query=')) ?? ''
    expect(firstGheArgv).toEqual(expect.arrayContaining(['--hostname', 'ghe.acme.internal']))
    expect(firstGheQuery).toContain('organization(login:$owner)')
  })
})
