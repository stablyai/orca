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
  classifyGhError,
  classifyListIssuesError,
  getIssueOwnerRepo,
  getOwnerRepo,
  parseGitHubOwnerRepo,
  resolveIssueSource
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

describe('resolveIssueSource', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    _resetOwnerRepoCache()
  })

  it("'auto' + upstream exists → upstream, fellBack=false", async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:stablyai/orca.git\n'
    })

    await expect(resolveIssueSource('/repo', 'auto')).resolves.toEqual({
      source: { owner: 'stablyai', repo: 'orca' },
      fellBack: false
    })
  })

  it("'auto' + no upstream → origin, fellBack=false", async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@example.com:stablyai/orca.git\n' })
      .mockResolvedValueOnce({ stdout: 'git@github.com:solo/orca.git\n' })

    await expect(resolveIssueSource('/repo', 'auto')).resolves.toEqual({
      source: { owner: 'solo', repo: 'orca' },
      fellBack: false
    })
  })

  it("'upstream' + upstream exists → upstream, fellBack=false", async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:stablyai/orca.git\n'
    })

    await expect(resolveIssueSource('/repo', 'upstream')).resolves.toEqual({
      source: { owner: 'stablyai', repo: 'orca' },
      fellBack: false
    })
  })

  it("'upstream' + no upstream remote → origin, fellBack=true", async () => {
    // No upstream remote configured — the first call fails.
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('fatal: No such remote'))
      .mockResolvedValueOnce({ stdout: 'git@github.com:solo/orca.git\n' })

    await expect(resolveIssueSource('/repo', 'upstream')).resolves.toEqual({
      source: { owner: 'solo', repo: 'orca' },
      fellBack: true
    })
  })

  it("'origin' + upstream exists → origin (ignores upstream), fellBack=false", async () => {
    // Only one gh call should happen — origin. Upstream is never consulted.
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:fork/orca.git\n'
    })

    await expect(resolveIssueSource('/repo', 'origin')).resolves.toEqual({
      source: { owner: 'fork', repo: 'orca' },
      fellBack: false
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo'
    })
  })

  it("'origin' + no upstream → origin, fellBack=false", async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:solo/orca.git\n'
    })

    await expect(resolveIssueSource('/repo', 'origin')).resolves.toEqual({
      source: { owner: 'solo', repo: 'orca' },
      fellBack: false
    })
  })

  it('undefined preference is treated identically to auto', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:stablyai/orca.git\n'
    })

    await expect(resolveIssueSource('/repo', undefined)).resolves.toEqual({
      source: { owner: 'stablyai', repo: 'orca' },
      fellBack: false
    })
  })
})

describe('gh error classification', () => {
  // Why: a fork with Issues turned off triggers `gh issue list` stderr
  // "the '<slug>' repository has disabled issues". Without a dedicated branch
  // the raw "Command failed: gh issue list …" line leaks into the Tasks banner
  // via the `unknown` fallback — which is what users see when they flip the
  // per-repo selector to an origin fork that has issues disabled.
  it('classifies "has disabled issues" stderr as issues_disabled', () => {
    const stderr =
      "Command failed: gh issue list --limit 36 --json number,title,state --repo brennanb2025/orca --state open\nthe 'brennanb2025/orca' repository has disabled issues"
    expect(classifyGhError(stderr)).toEqual({
      type: 'issues_disabled',
      message: 'Issues are disabled on this repository.'
    })
    expect(classifyListIssuesError(stderr)).toEqual({
      type: 'issues_disabled',
      message: 'Issues are disabled on this repository.'
    })
  })
})
