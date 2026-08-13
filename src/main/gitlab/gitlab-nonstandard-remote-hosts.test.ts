import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, glabExecFileAsyncMock, sshExecMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  glabExecFileAsyncMock: vi.fn(),
  sshExecMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  glabExecFileAsync: glabExecFileAsyncMock
}))

import { _resetProjectRefCache, getIssueProjectRef } from './gitlab-project-ref-resolution'
import { REMOTE_URL_PROBE_TIMEOUT_MS } from '../git/remote-url-probe'
import { NEGATIVE_ENTRY_TTL_MS } from '../git/remote-ref-probe-cache'
import { GLAB_KNOWN_HOSTS_TIMEOUT_MS } from './gitlab-known-host-probe'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'

describe('GitLab nonstandard remote host contracts', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    glabExecFileAsyncMock.mockReset()
    sshExecMock.mockReset()
    unregisterSshGitProvider('conn-1')
    _resetProjectRefCache()
  })

  afterEach(() => {
    vi.useRealTimers()
    unregisterSshGitProvider('conn-1')
  })

  it('uses bounded SSH provider calls and does not repeat the added fallback probes', async () => {
    sshExecMock.mockImplementation(async (args: string[]) => {
      if (args.length === 1) {
        return { stdout: 'myremote\n', stderr: '' }
      }
      if (args[2] === 'myremote') {
        return { stdout: 'git@gitlab.com:group/project.git\n', stderr: '' }
      }
      throw new Error(`error: No such remote '${args[2]}'`)
    })
    registerSshGitProvider('conn-1', { exec: sshExecMock } as never)

    await expect(getIssueProjectRef('/repo', ['gitlab.com'], 'conn-1')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'group/project'
    })
    expect(sshExecMock.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [['remote', 'get-url', 'upstream'], '/repo'],
      [['remote', 'get-url', 'origin'], '/repo'],
      [['remote'], '/repo'],
      [['remote', 'get-url', 'myremote'], '/repo']
    ])

    sshExecMock.mockClear()
    await getIssueProjectRef('/repo', ['gitlab.com'], 'conn-1')
    expect(sshExecMock.mock.calls.map((call) => call[0])).toEqual([
      ['remote', 'get-url', 'upstream'],
      ['remote', 'get-url', 'origin']
    ])
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('threads WSL execution through every fallback command and caches the result', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.length === 1) {
        return { stdout: 'myremote\n', stderr: '' }
      }
      if (args[2] === 'myremote') {
        return { stdout: 'git@gitlab.com:group/project.git\n', stderr: '' }
      }
      throw new Error(`error: No such remote '${args[2]}'`)
    })
    const options = { wslDistro: 'Ubuntu' }

    await expect(getIssueProjectRef('/repo', ['gitlab.com'], null, options)).resolves.toEqual({
      host: 'gitlab.com',
      path: 'group/project'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(4)
    expect(
      gitExecFileAsyncMock.mock.calls.every(
        (call) =>
          call[1]?.wslDistro === 'Ubuntu' && call[1]?.timeout === REMOTE_URL_PROBE_TIMEOUT_MS
      )
    ).toBe(true)

    gitExecFileAsyncMock.mockClear()
    await getIssueProjectRef('/repo', ['gitlab.com'], null, options)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does not re-probe a transient upstream through sole-remote fallback', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.length === 1) {
        return { stdout: 'upstream\n', stderr: '' }
      }
      if (args[2] === 'upstream') {
        throw new Error('git timed out')
      }
      throw new Error(`error: No such remote '${args[2]}'`)
    })

    await expect(getIssueProjectRef('/repo', ['gitlab.com'])).resolves.toBeNull()
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toEqual([
      ['remote', 'get-url', 'upstream'],
      ['remote', 'get-url', 'origin']
    ])
  })

  it('coalesces concurrent local resolution across the complete fallback', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      await Promise.resolve()
      if (args.length === 1) {
        return { stdout: 'myremote\n', stderr: '' }
      }
      if (args[2] === 'myremote') {
        return { stdout: 'git@gitlab.com:group/project.git\n', stderr: '' }
      }
      throw new Error(`error: No such remote '${args[2]}'`)
    })

    await expect(
      Promise.all(Array.from({ length: 8 }, () => getIssueProjectRef('/repo', ['gitlab.com'])))
    ).resolves.toEqual(
      Array.from({ length: 8 }, () => ({ host: 'gitlab.com', path: 'group/project' }))
    )
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toEqual([
      ['remote', 'get-url', 'upstream'],
      ['remote', 'get-url', 'origin'],
      ['remote'],
      ['remote', 'get-url', 'myremote']
    ])
  })

  it('coalesces concurrent WSL resolution across the complete fallback', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      await Promise.resolve()
      if (args.length === 1) {
        return { stdout: 'myremote\n', stderr: '' }
      }
      if (args[2] === 'myremote') {
        return { stdout: 'git@gitlab.com:group/project.git\n', stderr: '' }
      }
      throw new Error(`error: No such remote '${args[2]}'`)
    })
    const options = { wslDistro: 'Ubuntu' }

    await expect(
      Promise.all(
        Array.from({ length: 8 }, () => getIssueProjectRef('/repo', ['gitlab.com'], null, options))
      )
    ).resolves.toEqual(
      Array.from({ length: 8 }, () => ({ host: 'gitlab.com', path: 'group/project' }))
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(4)
    expect(gitExecFileAsyncMock.mock.calls.every((call) => call[1]?.wslDistro === 'Ubuntu')).toBe(
      true
    )
  })

  it('coalesces concurrent SSH resolution across the complete fallback', async () => {
    sshExecMock.mockImplementation(async (args: string[]) => {
      await Promise.resolve()
      if (args.length === 1) {
        return { stdout: 'myremote\n', stderr: '' }
      }
      if (args[2] === 'myremote') {
        return { stdout: 'git@gitlab.com:group/project.git\n', stderr: '' }
      }
      throw new Error(`error: No such remote '${args[2]}'`)
    })
    registerSshGitProvider('conn-1', { exec: sshExecMock } as never)

    await expect(
      Promise.all(
        Array.from({ length: 8 }, () => getIssueProjectRef('/repo', ['gitlab.com'], 'conn-1'))
      )
    ).resolves.toEqual(
      Array.from({ length: 8 }, () => ({ host: 'gitlab.com', path: 'group/project' }))
    )
    expect(sshExecMock.mock.calls.map((call) => call[0])).toEqual([
      ['remote', 'get-url', 'upstream'],
      ['remote', 'get-url', 'origin'],
      ['remote'],
      ['remote', 'get-url', 'myremote']
    ])
  })

  it('coalesces a concurrent failed enumeration', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      await Promise.resolve()
      if (args.length === 1) {
        return { stdout: 'fork\nmirror\n', stderr: '' }
      }
      throw new Error(`error: No such remote '${args[2]}'`)
    })

    await expect(
      Promise.all(Array.from({ length: 8 }, () => getIssueProjectRef('/repo', ['gitlab.com'])))
    ).resolves.toEqual(Array.from({ length: 8 }, () => null))
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toEqual([
      ['remote', 'get-url', 'upstream'],
      ['remote', 'get-url', 'origin'],
      ['remote']
    ])
  })

  it('recovers when the sole remote is replaced after the topology interval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    glabExecFileAsyncMock.mockRejectedValue(new Error('not authenticated'))
    let remoteName = 'oldremote'
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.length === 1) {
        return { stdout: `${remoteName}\n`, stderr: '' }
      }
      if (args[2] === 'myremote') {
        return { stdout: 'git@gitlab.com:group/project.git\n', stderr: '' }
      }
      if (args[2] === 'oldremote') {
        return { stdout: 'git@example.com:group/project.git\n', stderr: '' }
      }
      throw new Error(`error: No such remote '${args[2]}'`)
    })

    await expect(getIssueProjectRef('/repo', ['gitlab.com'])).resolves.toBeNull()
    remoteName = 'myremote'
    await expect(getIssueProjectRef('/repo', ['gitlab.com'])).resolves.toBeNull()
    vi.setSystemTime(1_000_000 + NEGATIVE_ENTRY_TTL_MS + 1)
    await expect(getIssueProjectRef('/repo', ['gitlab.com'])).resolves.toEqual({
      host: 'gitlab.com',
      path: 'group/project'
    })
  })

  it('bounds glab host discovery for a sole nonstandard remote', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.length === 1) {
        return { stdout: 'myremote\n', stderr: '' }
      }
      if (args[2] === 'myremote') {
        return { stdout: 'git@gitlab.internal:group/project.git\n', stderr: '' }
      }
      throw new Error(`error: No such remote '${args[2]}'`)
    })
    glabExecFileAsyncMock.mockRejectedValue(new Error('not authenticated'))

    await expect(getIssueProjectRef('/repo', ['gitlab.com'])).resolves.toBeNull()
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['auth', 'status', '--hostname', 'gitlab.internal'],
      { timeout: GLAB_KNOWN_HOSTS_TIMEOUT_MS }
    )
  })

  it('coalesces host discovery across concurrent repos', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      await Promise.resolve()
      if (args.length === 1) {
        return { stdout: 'myremote\n', stderr: '' }
      }
      if (args[2] === 'myremote') {
        return { stdout: 'git@gitlab.internal:group/project.git\n', stderr: '' }
      }
      throw new Error(`error: No such remote '${args[2]}'`)
    })
    glabExecFileAsyncMock.mockImplementation(async () => {
      await Promise.resolve()
      throw new Error('not authenticated')
    })

    await expect(
      Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          getIssueProjectRef(`/repo-${index}`, ['gitlab.com'])
        )
      )
    ).resolves.toEqual(Array.from({ length: 8 }, () => null))
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['auth', 'status', '--hostname', 'gitlab.internal'],
      { timeout: GLAB_KNOWN_HOSTS_TIMEOUT_MS }
    )
  })

  it('memoizes a definitive unauthenticated host across repo paths', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.length === 1) {
        return { stdout: 'myremote\n', stderr: '' }
      }
      if (args[2] === 'myremote') {
        return { stdout: 'git@gitlab.internal:group/project.git\n', stderr: '' }
      }
      throw new Error(`error: No such remote '${args[2]}'`)
    })
    glabExecFileAsyncMock.mockRejectedValue(new Error('not authenticated'))

    await expect(getIssueProjectRef('/repo-a', ['gitlab.com'])).resolves.toBeNull()
    await expect(getIssueProjectRef('/repo-b', ['gitlab.com'])).resolves.toBeNull()

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(8)
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['auth', 'status', '--hostname', 'gitlab.internal'],
      { timeout: GLAB_KNOWN_HOSTS_TIMEOUT_MS }
    )
  })

  it.each([
    'glab timed out',
    'network is unreachable',
    'could not resolve host: gitlab.internal',
    'dial tcp 10.0.0.1:443: i/o timeout',
    'context deadline exceeded',
    'HTTP 503 Service Unavailable',
    'HTTP 502 Bad Gateway',
    'unexpected EOF',
    'dial tcp: lookup gitlab.internal on 127.0.0.53:53: server misbehaving',
    'Temporary failure in name resolution',
    'connect: no route to host'
  ])('retries host discovery after a transient failure: %s', async (message) => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.length === 1) {
        return { stdout: 'myremote\n', stderr: '' }
      }
      if (args[2] === 'myremote') {
        return { stdout: 'git@gitlab.internal:group/project.git\n', stderr: '' }
      }
      throw new Error(`error: No such remote '${args[2]}'`)
    })
    glabExecFileAsyncMock
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(getIssueProjectRef('/repo', ['gitlab.com'])).resolves.toBeNull()
    await expect(getIssueProjectRef('/repo', ['gitlab.com'])).resolves.toEqual({
      host: 'gitlab.internal',
      path: 'group/project'
    })
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not guess among multiple nonstandard remotes', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.length === 1) {
        return { stdout: 'fork\nmirror\n', stderr: '' }
      }
      throw new Error(`error: No such remote '${args[2]}'`)
    })

    await expect(getIssueProjectRef('/repo', ['gitlab.com'])).resolves.toBeNull()
    await expect(getIssueProjectRef('/repo', ['gitlab.com'])).resolves.toBeNull()
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toEqual([
      ['remote', 'get-url', 'upstream'],
      ['remote', 'get-url', 'origin'],
      ['remote']
    ])
  })
})
