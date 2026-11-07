import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock, resolveWithSshGMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  resolveWithSshGMock: vi.fn()
}))

vi.mock('../command-runner/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: ghExecFileAsyncMock
}))

vi.mock('../../ssh/config/ssh-g-config-resolution', () => ({
  resolveWithSshG: resolveWithSshGMock
}))

import { getRemoteCommitUrl } from '../repo'
import { _resetGitHubHostAuthCache } from '../../github/github-enterprise-repository'
import { _resetSshHostnameResolutionCache } from '../../github/github-ssh-host-alias-resolution'

describe('Enterprise commit links', () => {
  let repoPath: string

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' })

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'orca-enterprise-commit-'))
    git('init', '--quiet')
    ghExecFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: 'github.example.com\n  ✓ Logged in to github.example.com account developer (keyring)',
      stderr: ''
    })
    resolveWithSshGMock.mockReset()
    resolveWithSshGMock.mockResolvedValue(null)
    _resetGitHubHostAuthCache()
    _resetSshHostnameResolutionCache()
  })

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true })
  })

  it.each([
    'https://github.example.com/Org/Repo.git',
    'git@github.example.com:Org/Repo.git',
    'ssh://git@github.example.com:2222/Org/Repo.git',
    'git+ssh://git@github.example.com/Org/Repo.git'
  ])('opens a commit for an authenticated Enterprise remote: %s', async (remote) => {
    git('remote', 'add', 'origin', remote)

    await expect(getRemoteCommitUrl(repoPath, ' abc123 ')).resolves.toBe(
      'https://github.example.com/Org/Repo/commit/abc123'
    )
    await expect(getRemoteCommitUrl(repoPath, ' ')).resolves.toBeNull()
    git('remote', 'set-url', 'origin', 'https://gitlab.example.com/Org/Repo.git')
    await expect(getRemoteCommitUrl(repoPath, 'abc123')).resolves.toBeNull()
  })

  it('preserves the authenticated web port instead of the SSH transport port', async () => {
    ghExecFileAsyncMock.mockResolvedValue({
      stdout:
        'github.example.com:8443\n  ✓ Logged in to github.example.com:8443 account developer (keyring)',
      stderr: ''
    })
    git('remote', 'add', 'origin', 'https://github.example.com:8443/Org/Repo.git')
    await expect(getRemoteCommitUrl(repoPath, 'abc123')).resolves.toBe(
      'https://github.example.com:8443/Org/Repo/commit/abc123'
    )
    git('remote', 'set-url', 'origin', 'ssh://git@github.example.com:2222/Org/Repo.git')
    await expect(getRemoteCommitUrl(repoPath, 'abc123')).resolves.toBe(
      'https://github.example.com:8443/Org/Repo/commit/abc123'
    )
  })

  it('resolves an SSH alias to the authenticated Enterprise web host', async () => {
    git('remote', 'add', 'origin', 'git@work-github:Org/Repo.git')
    resolveWithSshGMock.mockResolvedValue({ hostname: 'github.example.com' })

    await expect(getRemoteCommitUrl(repoPath, 'abc123')).resolves.toBe(
      'https://github.example.com/Org/Repo/commit/abc123'
    )
  })

  it('honors Git insteadOf rewrites and leaves public forge links working without gh', async () => {
    git('config', 'url.https://github.example.com/.insteadOf', 'work:')
    git('remote', 'add', 'origin', 'work:Org/Repo.git')
    await expect(getRemoteCommitUrl(repoPath, 'abc123')).resolves.toBe(
      'https://github.example.com/Org/Repo/commit/abc123'
    )

    ghExecFileAsyncMock.mockRejectedValue(new Error('gh unavailable'))
    git('remote', 'set-url', 'origin', 'git@github.com:Org/Repo.git')
    await expect(getRemoteCommitUrl(repoPath, 'abc123')).resolves.toBe(
      'https://github.com/Org/Repo/commit/abc123'
    )
    git('remote', 'set-url', 'origin', 'git@gitlab.com:group/sub/repo.git')
    await expect(getRemoteCommitUrl(repoPath, 'abc123')).resolves.toBe(
      'https://gitlab.com/group/sub/repo/-/commit/abc123'
    )
    git('remote', 'set-url', 'origin', 'git@bitbucket.org:team/repo.git')
    await expect(getRemoteCommitUrl(repoPath, 'abc123')).resolves.toBe(
      'https://bitbucket.org/team/repo/commits/abc123'
    )
    git('remote', 'set-url', 'origin', 'https://unknown.example.com/Org/Repo.git')
    await expect(getRemoteCommitUrl(repoPath, 'abc123')).resolves.toBeNull()
  })
})
