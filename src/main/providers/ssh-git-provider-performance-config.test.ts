import { beforeEach, describe, expect, it } from 'vitest'
import { SshGitProvider } from './ssh-git-provider'
import { createMockMux, type MockMultiplexer } from './ssh-git-provider-test-harness'

function methodNotFound(method: string): Error & { code: number } {
  return Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
}

const APPLIED = {
  state: { orcaKeys: [{ key: 'checkout.workers', value: '0' }], userKeys: [] },
  plan: [{ key: 'checkout.workers', value: '0', action: 'set' }]
}

describe('SshGitProvider.repoPerformanceConfig', () => {
  let mux: MockMultiplexer
  let provider: SshGitProvider

  beforeEach(() => {
    mux = createMockMux()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements every multiplexer method the provider calls.
    provider = new SshGitProvider('conn-1', mux as never)
  })

  it('asks the relay to plan and apply host-side, and validates the reply', async () => {
    mux.request.mockResolvedValue(APPLIED)

    await expect(provider.repoPerformanceConfig('/home/me/repo', 'apply')).resolves.toEqual(APPLIED)
    expect(mux.request).toHaveBeenCalledWith('git.repoPerformanceConfig', {
      repoPath: '/home/me/repo',
      action: 'apply'
    })
  })

  it('forwards the file-watcher opt-in and a partial revert only when set', async () => {
    mux.request.mockResolvedValue(APPLIED)
    await provider.repoPerformanceConfig('/home/me/repo', 'apply', { fsmonitor: true })
    await provider.repoPerformanceConfig('/home/me/repo', 'apply', { fsmonitor: false })
    await provider.repoPerformanceConfig('/home/me/repo', 'revert', { keys: ['core.fsmonitor'] })
    expect(mux.request.mock.calls.map((call) => call[1])).toEqual([
      { repoPath: '/home/me/repo', action: 'apply', fsmonitor: true },
      { repoPath: '/home/me/repo', action: 'apply' },
      { repoPath: '/home/me/repo', action: 'revert', keys: ['core.fsmonitor'] }
    ])
  })

  it('treats an older relay as unsupported once and stops asking', async () => {
    mux.request.mockRejectedValue(methodNotFound('git.repoPerformanceConfig'))

    await expect(provider.repoPerformanceConfig('/home/me/a', 'inspect')).resolves.toBeNull()
    await expect(provider.repoPerformanceConfig('/home/me/b', 'apply')).resolves.toBeNull()
    expect(mux.request).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent first probes against an older relay', async () => {
    let rejectFirst!: (error: Error) => void
    mux.request.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject
        })
    )

    const first = provider.repoPerformanceConfig('/home/me/a', 'inspect')
    const second = provider.repoPerformanceConfig('/home/me/b', 'inspect')
    rejectFirst(methodNotFound('git.repoPerformanceConfig'))

    await expect(Promise.all([first, second])).resolves.toEqual([null, null])
    expect(mux.request).toHaveBeenCalledTimes(1)
  })

  it('keeps other relay failures as errors rather than marking the host unsupported', async () => {
    mux.request.mockRejectedValueOnce(new Error('index.lock exists'))
    await expect(provider.repoPerformanceConfig('/home/me/a', 'apply')).rejects.toThrow(
      'index.lock exists'
    )
    mux.request.mockResolvedValueOnce(APPLIED)
    await expect(provider.repoPerformanceConfig('/home/me/a', 'apply')).resolves.toEqual(APPLIED)
  })

  it('isolates SSH hosts: a reconnect gets a fresh provider that probes again', async () => {
    mux.request.mockRejectedValue(methodNotFound('git.repoPerformanceConfig'))
    await provider.repoPerformanceConfig('/home/me/a', 'inspect')

    const upgradedMux = createMockMux()
    upgradedMux.request.mockResolvedValue(APPLIED)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements every multiplexer method the provider calls.
    const reconnected = new SshGitProvider('conn-1', upgradedMux as never)
    await expect(reconnected.repoPerformanceConfig('/home/me/a', 'apply')).resolves.toEqual(APPLIED)
  })
})
