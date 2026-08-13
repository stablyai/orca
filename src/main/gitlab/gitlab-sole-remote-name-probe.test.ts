import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, sshExecMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  sshExecMock: vi.fn()
}))

vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import {
  _getSoleRemoteNameProbeCacheSize,
  clearSoleRemoteNameProbeCache,
  getSoleRemoteName
} from './gitlab-sole-remote-name-probe'
import { REMOTE_URL_PROBE_TIMEOUT_MS } from '../git/remote-url-probe'
import { NEGATIVE_ENTRY_TTL_MS } from '../git/remote-ref-probe-cache'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'

describe('sole Git remote name probe', () => {
  beforeEach(() => {
    vi.useRealTimers()
    gitExecFileAsyncMock.mockReset()
    sshExecMock.mockReset()
    unregisterSshGitProvider('conn-1')
    clearSoleRemoteNameProbeCache()
  })

  it('lists a local WSL remote once and reuses the result', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'myremote\r\n', stderr: '' })

    await expect(getSoleRemoteName('/repo', null, { wslDistro: 'Ubuntu' })).resolves.toBe(
      'myremote'
    )
    await expect(getSoleRemoteName('/repo', null, { wslDistro: 'Ubuntu' })).resolves.toBe(
      'myremote'
    )

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['remote'], { cwd: '/repo', timeout: REMOTE_URL_PROBE_TIMEOUT_MS, wslDistro: 'Ubuntu' }]
    ])
  })

  it('coalesces concurrent sole-remote name probes', async () => {
    let releaseProbe!: () => void
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    gitExecFileAsyncMock.mockImplementationOnce(async () => {
      await probeGate
      return { stdout: 'myremote\n', stderr: '' }
    })

    const probes = Array.from({ length: 64 }, () => getSoleRemoteName('/repo'))
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    releaseProbe()

    await expect(Promise.all(probes)).resolves.toEqual(Array.from({ length: 64 }, () => 'myremote'))
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('uses the SSH provider and keeps its cache isolated from local Git', async () => {
    sshExecMock.mockResolvedValue({ stdout: 'myremote\n', stderr: '' })
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'localremote\n', stderr: '' })
    registerSshGitProvider('conn-1', { exec: sshExecMock } as never)

    await expect(getSoleRemoteName('/repo', 'conn-1')).resolves.toBe('myremote')
    await expect(getSoleRemoteName('/repo')).resolves.toBe('localremote')

    expect(sshExecMock).toHaveBeenCalledWith(['remote'], '/repo', {
      signal: expect.any(AbortSignal)
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('refuses to guess among multiple remotes and caches the bounded miss', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'fork\nmirror\n', stderr: '' })

    await expect(getSoleRemoteName('/repo')).resolves.toBeNull()
    await expect(getSoleRemoteName('/repo')).resolves.toBeNull()

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed list probe', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('git timed out'))
      .mockResolvedValueOnce({ stdout: 'myremote\n', stderr: '' })

    await expect(getSoleRemoteName('/repo')).resolves.toBeNull()
    await expect(getSoleRemoteName('/repo')).resolves.toBe('myremote')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('refreshes a cached sole remote after the topology interval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'oldremote\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'myremote\n', stderr: '' })

    await expect(getSoleRemoteName('/repo')).resolves.toBe('oldremote')
    await expect(getSoleRemoteName('/repo')).resolves.toBe('oldremote')
    vi.setSystemTime(1_000_000 + NEGATIVE_ENTRY_TTL_MS + 1)
    await expect(getSoleRemoteName('/repo')).resolves.toBe('myremote')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('bounds cached repo locations', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'myremote\n', stderr: '' })

    for (let index = 0; index < 513; index += 1) {
      await getSoleRemoteName(`/repo-${index}`)
    }

    expect(_getSoleRemoteNameProbeCacheSize()).toBe(512)
  })
})
