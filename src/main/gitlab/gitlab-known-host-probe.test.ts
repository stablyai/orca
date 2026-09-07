import { beforeEach, describe, expect, it, vi } from 'vitest'

const { glabExecFileAsyncMock } = vi.hoisted(() => ({ glabExecFileAsyncMock: vi.fn() }))

vi.mock('../git/runner', () => ({ glabExecFileAsync: glabExecFileAsyncMock }))

import {
  _resetKnownHostsCache,
  getGlabKnownHosts,
  rememberGlabKnownHost,
  rememberGlabKnownHosts
} from './gitlab-known-host-probe'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'

describe('getGlabKnownHosts', () => {
  // A locally-keyed probe must never answer from the default WSL distro.
  const LOCAL_PROBE_OPTIONS = { timeout: 10_000, allowDefaultWslFallback: false }

  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
    _resetKnownHostsCache()
  })

  it('returns gitlab.com plus auth-status hosts, deduped', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '✓ Logged in to gitlab.com as user\n✓ Logged in to gitlab.example.com as user\n',
      stderr: ''
    })

    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'gitlab.example.com'])
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(['auth', 'status'], LOCAL_PROBE_OPTIONS)
  })

  it('preserves WSL and background admission on the cold auth-status probe', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await getGlabKnownHosts(undefined, {
      wslDistro: 'Ubuntu',
      admissionTier: 'background'
    })

    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(['auth', 'status'], {
      ...LOCAL_PROBE_OPTIONS,
      wslDistro: 'Ubuntu',
      admissionTier: 'background'
    })
  })

  it('falls back to default when glab auth status fails', async () => {
    glabExecFileAsyncMock.mockRejectedValueOnce(new Error('glab not authenticated'))

    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com'])
  })

  it('caches the result across calls', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '✓ Logged in to gitlab.com as user\n',
      stderr: ''
    })

    await getGlabKnownHosts()
    await getGlabKnownHosts()
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces many simultaneous callers in one execution context', async () => {
    let resolveProbe!: (value: { stdout: string; stderr: string }) => void
    glabExecFileAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve
        })
    )

    const probes = Array.from({ length: 64 }, () => getGlabKnownHosts())

    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)
    resolveProbe({ stdout: 'Logged in to gitlab.concurrent.test as user\n', stderr: '' })
    const results = await Promise.all(probes)
    expect(results.every((result) => result === results[0])).toBe(true)
    expect(results[0]).toEqual(['gitlab.com', 'gitlab.concurrent.test'])
  })

  it('keeps simultaneous native, WSL distro, and connection probes isolated', async () => {
    glabExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'Logged in to ubuntu.test as user\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Logged in to debian.test as user\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Logged in to native.test as user\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Logged in to ssh.test as user\n', stderr: '' })

    const [ubuntu, ubuntuAgain, debian, native, ssh] = await Promise.all([
      getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' }),
      getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' }),
      getGlabKnownHosts(undefined, { wslDistro: 'Debian' }),
      getGlabKnownHosts(),
      getGlabKnownHosts('conn-1')
    ])

    expect(ubuntuAgain).toBe(ubuntu)
    expect(ubuntu).toEqual(['gitlab.com', 'ubuntu.test'])
    expect(debian).toEqual(['gitlab.com', 'debian.test'])
    expect(native).toEqual(['gitlab.com', 'native.test'])
    expect(ssh).toEqual(['gitlab.com', 'ssh.test'])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(4)
    expect(glabExecFileAsyncMock).toHaveBeenNthCalledWith(1, ['auth', 'status'], {
      ...LOCAL_PROBE_OPTIONS,
      wslDistro: 'Ubuntu'
    })
    expect(glabExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['auth', 'status'], {
      ...LOCAL_PROBE_OPTIONS,
      wslDistro: 'Debian'
    })
  })

  it('preserves a native auth refresh while an older native probe is in flight', async () => {
    let resolveProbe!: (value: { stdout: string; stderr: string }) => void
    glabExecFileAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve
        })
    )

    const staleProbe = getGlabKnownHosts()
    rememberGlabKnownHost('gitlab.refreshed.test')
    resolveProbe({ stdout: 'Logged in to gitlab.com as user\n', stderr: '' })

    await expect(staleProbe).resolves.toEqual(['gitlab.com', 'gitlab.refreshed.test'])
    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'gitlab.refreshed.test'])
  })

  it('preserves a native auth refresh when an older native probe fails', async () => {
    let rejectProbe!: (error: Error) => void
    glabExecFileAsyncMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectProbe = reject
        })
    )

    const staleProbe = getGlabKnownHosts()
    rememberGlabKnownHost('gitlab.refreshed.test')
    rejectProbe(new Error('stale auth probe failed'))

    await expect(staleProbe).resolves.toEqual(['gitlab.com', 'gitlab.refreshed.test'])
    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'gitlab.refreshed.test'])
  })

  it('keeps a remembered native host out of WSL and SSH caches', async () => {
    glabExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'Logged in to native.test as user\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Logged in to wsl.test as user\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Logged in to ssh.test as user\n', stderr: '' })

    await Promise.all([
      getGlabKnownHosts(),
      getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' }),
      getGlabKnownHosts('conn-1')
    ])
    rememberGlabKnownHost('gitlab.refreshed.test')

    await expect(getGlabKnownHosts()).resolves.toEqual([
      'gitlab.com',
      'native.test',
      'gitlab.refreshed.test'
    ])
    await expect(getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })).resolves.toEqual([
      'gitlab.com',
      'wsl.test'
    ])
    await expect(getGlabKnownHosts('conn-1')).resolves.toEqual(['gitlab.com', 'ssh.test'])
  })

  it('batch-normalizes and deduplicates hosts in first-seen order per execution context', async () => {
    rememberGlabKnownHosts([' Native-B.test ', 'native-a.test', 'NATIVE-B.TEST'])
    rememberGlabKnownHosts(['WSL-B.test', ' wsl-a.test ', 'wsl-b.test'], undefined, {
      wslDistro: 'Ubuntu'
    })
    rememberGlabKnownHosts(['SSH-B.test', 'ssh-a.test', ' ssh-b.test '], 'conn-batch')

    await expect(getGlabKnownHosts()).resolves.toEqual([
      'gitlab.com',
      'native-b.test',
      'native-a.test'
    ])
    await expect(getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })).resolves.toEqual([
      'gitlab.com',
      'wsl-b.test',
      'wsl-a.test'
    ])
    await expect(getGlabKnownHosts('conn-batch')).resolves.toEqual([
      'gitlab.com',
      'ssh-b.test',
      'ssh-a.test'
    ])
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('recognizes a self-hosted host on a non-default port', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '✓ Logged in to gitlab.example.com:8080 as user\n',
      stderr: ''
    })

    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'gitlab.example.com:8080'])
  })

  it('caches per connection — the local probe does not satisfy a connection probe', async () => {
    glabExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '✓ Logged in to gitlab.com as user\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout: '✓ Logged in to gitlab.example.com:8080 as user\n',
        stderr: ''
      })

    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com'])
    await expect(getGlabKnownHosts('conn-1')).resolves.toEqual([
      'gitlab.com',
      'gitlab.example.com:8080'
    ])
    // A second probe for the same connection is served from cache.
    await expect(getGlabKnownHosts('conn-1')).resolves.toEqual([
      'gitlab.com',
      'gitlab.example.com:8080'
    ])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not permanently cache the failure fallback — a later probe can re-discover hosts', async () => {
    glabExecFileAsyncMock
      .mockRejectedValueOnce(new Error('ssh tunnel not ready'))
      .mockResolvedValueOnce({
        stdout: '✓ Logged in to gitlab.example.com:8080 as user\n',
        stderr: ''
      })

    // First probe fails → canonical default, NOT cached.
    await expect(getGlabKnownHosts('conn-1')).resolves.toEqual(['gitlab.com'])
    // Re-probe (e.g. after tunnel comes up) discovers the real host.
    await expect(getGlabKnownHosts('conn-1')).resolves.toEqual([
      'gitlab.com',
      'gitlab.example.com:8080'
    ])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('removes a timed-out probe from in-flight state so a later call retries', async () => {
    let rejectProbe!: (error: Error) => void
    glabExecFileAsyncMock
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectProbe = reject
          })
      )
      .mockResolvedValueOnce({ stdout: 'Logged in to recovered.test as user\n', stderr: '' })

    const first = getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })
    const concurrent = getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)
    rejectProbe(new Error('wsl.exe timed out.'))

    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      ['gitlab.com'],
      ['gitlab.com']
    ])
    await expect(getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })).resolves.toEqual([
      'gitlab.com',
      'recovered.test'
    ])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a successful result after an SSH provider reconnects', async () => {
    const connectionId = 'conn-reconnected'
    registerSshGitProvider(connectionId, {} as never)
    glabExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'Logged in to old-tunnel.test as user\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Logged in to new-tunnel.test as user\n', stderr: '' })

    await expect(getGlabKnownHosts(connectionId)).resolves.toEqual([
      'gitlab.com',
      'old-tunnel.test'
    ])
    registerSshGitProvider(connectionId, {} as never)
    await expect(getGlabKnownHosts(connectionId)).resolves.toEqual([
      'gitlab.com',
      'new-tunnel.test'
    ])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
    unregisterSshGitProvider(connectionId)
  })
})
