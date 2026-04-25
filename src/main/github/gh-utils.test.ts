import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  ghExecFileAsync: vi.fn()
}))

import {
  _resetOwnerRepoCache,
  getIssueOwnerRepo,
  getOwnerRepo,
  parseGitHubOwnerRepo
} from './gh-utils'

describe('github owner/repo resolution', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    _resetOwnerRepoCache()
  })

  it('parses GitHub HTTPS and SSH remotes', () => {
    expect(parseGitHubOwnerRepo('https://github.com/acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets'
    })
    expect(parseGitHubOwnerRepo('git@github.com:stablyai/orca.git')).toEqual({
      owner: 'stablyai',
      repo: 'orca'
    })
    expect(parseGitHubOwnerRepo('git@github.com:TheBoredTeam/boring.notch.git')).toEqual({
      owner: 'TheBoredTeam',
      repo: 'boring.notch'
    })
    expect(parseGitHubOwnerRepo('git@example.com:stablyai/orca.git')).toBeNull()
  })

  it('keeps getOwnerRepo origin-based', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:fork/orca.git\n'
    })

    await expect(getOwnerRepo('/repo')).resolves.toEqual({ owner: 'fork', repo: 'orca' })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo'
    })
  })

  it('prefers upstream for issue owner/repo resolution', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:stablyai/orca.git\n'
    })

    await expect(getIssueOwnerRepo('/repo')).resolves.toEqual({ owner: 'stablyai', repo: 'orca' })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'upstream'], {
      cwd: '/repo'
    })
  })

  it('falls back to origin when upstream is missing or non-GitHub', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@example.com:stablyai/orca.git\n' })
      .mockResolvedValueOnce({ stdout: 'git@github.com:fork/orca.git\n' })

    await expect(getIssueOwnerRepo('/repo')).resolves.toEqual({ owner: 'fork', repo: 'orca' })
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(1, ['remote', 'get-url', 'upstream'], {
      cwd: '/repo'
    })
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['remote', 'get-url', 'origin'], {
      cwd: '/repo'
    })
  })

  it('does not mix origin and upstream cache entries for the same repo path', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@github.com:fork/orca.git\n' })
      .mockResolvedValueOnce({ stdout: 'git@github.com:stablyai/orca.git\n' })

    await expect(getOwnerRepo('/repo')).resolves.toEqual({ owner: 'fork', repo: 'orca' })
    await expect(getIssueOwnerRepo('/repo')).resolves.toEqual({ owner: 'stablyai', repo: 'orca' })
  })
})
