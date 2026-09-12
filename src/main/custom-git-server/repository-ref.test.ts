import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetCustomGitServerRepoRefCache,
  getCustomGitServerRepoRef,
  parseCustomGitServerRemote
} from './repository-ref'

const gitExecFileAsync = vi.fn()
vi.mock('../git/runner', () => ({ gitExecFileAsync: (...args: unknown[]) => gitExecFileAsync(...args) }))
vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProvider: () => undefined }))

const server = { id: 's1', name: 'S', host: 'git.example.com', apiBaseUrl: 'https://git.example.com', apiFlavor: 'gitlab' as const }
vi.mock('./server-config-store', () => ({
  listCustomGitServers: () => [server],
  getCustomGitServerForHost: (host: string) => (host === server.host ? server : null)
}))

describe('parseCustomGitServerRemote', () => {
  it('parses an https remote', () => {
    expect(parseCustomGitServerRemote('https://git.example.com/team/orca.git')).toEqual({
      host: 'git.example.com',
      owner: 'team',
      repo: 'orca'
    })
  })

  it('parses an scp-like ssh remote', () => {
    expect(parseCustomGitServerRemote('git@git.example.com:team/orca.git')).toEqual({
      host: 'git.example.com',
      owner: 'team',
      repo: 'orca'
    })
  })

  it('keeps nested groups in the owner path', () => {
    expect(parseCustomGitServerRemote('https://git.example.com/group/sub/orca.git')).toEqual({
      host: 'git.example.com',
      owner: 'group/sub',
      repo: 'orca'
    })
  })

  it('keeps the http(s) port in the host', () => {
    expect(parseCustomGitServerRemote('https://git.example.com:8443/team/orca')).toEqual({
      host: 'git.example.com:8443',
      owner: 'team',
      repo: 'orca'
    })
  })

  it('drops the ssh transport port from the host', () => {
    expect(parseCustomGitServerRemote('ssh://git@git.example.com:2222/team/orca.git')).toEqual({
      host: 'git.example.com',
      owner: 'team',
      repo: 'orca'
    })
  })

  it('returns null for a path without owner/repo', () => {
    expect(parseCustomGitServerRemote('https://git.example.com/orca')).toBeNull()
  })

  it('returns null for an unsupported protocol', () => {
    expect(parseCustomGitServerRemote('ftp://git.example.com/team/orca')).toBeNull()
  })
})

describe('getCustomGitServerRepoRef cache TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    gitExecFileAsync.mockReset()
    _resetCustomGitServerRepoRefCache()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-reads a changed origin after the TTL elapses', async () => {
    gitExecFileAsync
      .mockResolvedValueOnce({ stdout: 'https://git.example.com/team/orca.git', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'https://git.example.com/team/renamed.git', stderr: '' })

    expect(await getCustomGitServerRepoRef('/repo')).toEqual({ server, owner: 'team', repo: 'orca' })
    // Within the TTL the cached value is reused (no second git call).
    vi.advanceTimersByTime(29_000)
    expect(await getCustomGitServerRepoRef('/repo')).toEqual({ server, owner: 'team', repo: 'orca' })
    expect(gitExecFileAsync).toHaveBeenCalledTimes(1)

    // Past the TTL the origin is re-read and the new repo is reflected.
    vi.advanceTimersByTime(2_000)
    expect(await getCustomGitServerRepoRef('/repo')).toEqual({ server, owner: 'team', repo: 'renamed' })
    expect(gitExecFileAsync).toHaveBeenCalledTimes(2)
  })
})
