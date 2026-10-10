import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GhUtils from './gh-utils'
import type * as ApiRepository from './github-api-repository'
import type * as EnterpriseRepository from './github-enterprise-repository'

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  heuristic: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn()
}))

vi.mock('./gh-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof GhUtils>()),
  ghExecFileAsync: mocks.exec,
  acquire: mocks.acquire,
  release: mocks.release
}))
vi.mock('./github-api-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiRepository>()),
  getIssueGitHubApiRepository: mocks.heuristic
}))
vi.mock('./github-enterprise-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof EnterpriseRepository>()),
  isGitHubHostAuthenticated: vi.fn().mockResolvedValue(true)
}))

import { getIssue } from './issues'

describe('linked issue repository', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.heuristic.mockResolvedValue({ owner: 'parent', repo: 'repo', host: 'github.com' })
    mocks.exec.mockResolvedValue({
      stdout: JSON.stringify({
        number: 247,
        title: 'Fork issue',
        state: 'open',
        html_url: 'https://github.com/fork/repo/issues/247',
        labels: [],
        body: 'Fork description'
      })
    })
  })

  it('reads the saved fork instead of upstream and preserves the description', async () => {
    await expect(
      getIssue('/repo', 247, null, {}, { owner: 'fork', repo: 'repo', host: 'github.com' })
    ).resolves.toMatchObject({ title: 'Fork issue', description: 'Fork description' })
    expect(mocks.exec).toHaveBeenCalledWith(
      ['api', '--cache', '300s', 'repos/fork/repo/issues/247'],
      { cwd: '/repo', host: 'github.com' }
    )
    expect(mocks.heuristic).not.toHaveBeenCalled()
  })

  it('preserves WSL execution and the saved Enterprise host', async () => {
    await getIssue(
      '/repo',
      247,
      null,
      { wslDistro: 'DevBox' },
      {
        owner: 'fork',
        repo: 'repo',
        host: 'git.example.com:8443'
      }
    )
    expect(mocks.exec).toHaveBeenCalledWith(
      ['api', '--cache', '300s', 'repos/fork/repo/issues/247'],
      { cwd: '/repo', wslDistro: 'DevBox', host: 'git.example.com:8443' }
    )
  })

  it('does not use an SSH checkout path as a local cwd', async () => {
    await getIssue('/repo', 247, 'ssh-1', {}, { owner: 'fork', repo: 'repo', host: 'github.com' })
    expect(mocks.exec).toHaveBeenCalledWith(
      ['api', '--cache', '300s', 'repos/fork/repo/issues/247'],
      { host: 'github.com' }
    )
  })

  it('retains upstream-first lookup for old number-only links', async () => {
    await getIssue('/repo', 247)
    expect(mocks.exec).toHaveBeenCalledWith(
      ['api', '--cache', '300s', 'repos/parent/repo/issues/247'],
      { cwd: '/repo', host: 'github.com' }
    )
  })

  it('does not fall back to another repository when the explicit fetch fails', async () => {
    mocks.exec.mockRejectedValue(new Error('not found'))
    await expect(
      getIssue('/repo', 247, null, {}, { owner: 'fork', repo: 'repo', host: 'github.com' })
    ).resolves.toBeNull()
    expect(mocks.exec).toHaveBeenCalledTimes(1)
    expect(mocks.heuristic).not.toHaveBeenCalled()
  })

  it('rejects an invalid override before executing gh', async () => {
    await expect(
      getIssue('/repo', 247, null, {}, { owner: 'fork', repo: '../parent' })
    ).resolves.toBeNull()
    expect(mocks.exec).not.toHaveBeenCalled()
  })
})
