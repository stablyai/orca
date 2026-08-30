import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runWslProcessMock } = vi.hoisted(() => ({ runWslProcessMock: vi.fn() }))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import {
  _internals,
  drainLegacyWslRuntimeAuth,
  startLegacyWslRuntimeAuthDrain
} from './legacy-wsl-runtime-auth-drain'

const SOURCE = '{"tokens":{"expires_at":2000}}\n'
const STALE = '{"tokens":{"expires_at":1000}}\n'
const MALFORMED = '{"tokens":{"expires_at":}}\n'
function inspection(auth: string, credentials?: string): string {
  return [
    Buffer.from(auth).toString('base64'),
    credentials === undefined ? 'missing' : 'present',
    credentials === undefined ? '' : Buffer.from(credentials).toString('base64')
  ].join('\n')
}
function result(code: number, stdout = '') {
  return { code, stdout, stderr: '', timedOut: false, environmentResolved: true }
}

describe('legacy WSL runtime auth drain', () => {
  beforeEach(() => {
    runWslProcessMock.mockReset()
    _internals.resetDrainQueue()
  })

  it('promotes fresher auth and preserves promoteAuth/deleteSource arguments', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(result(0, inspection(SOURCE)))
      .mockResolvedValueOnce(result(0))
    await drainLegacyWslRuntimeAuth({
      distro: 'Ubuntu',
      guestHomeLinuxPath: '/home/alice',
      legacyPanePresent: false,
      resolveDestination: () => ({ authContents: STALE, linuxHomePath: '/home/alice/.codex' })
    })
    expect(runWslProcessMock).toHaveBeenCalledTimes(2)
    expect(runWslProcessMock.mock.calls[1][0].args.slice(-3)).toEqual(['1', '1', 'missing'])
  })

  it('fails closed for corrupt or partial destination auth', async () => {
    runWslProcessMock.mockResolvedValueOnce(result(0, inspection(SOURCE)))
    await drainLegacyWslRuntimeAuth({
      distro: 'Ubuntu',
      guestHomeLinuxPath: '/home/alice',
      legacyPanePresent: false,
      resolveDestination: () => ({ authContents: MALFORMED, linuxHomePath: '/home/alice/.codex' })
    })
    expect(runWslProcessMock).toHaveBeenCalledTimes(1)
  })

  it('keeps an older destination and retires source only after guest validation', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(result(0, inspection(SOURCE)))
      .mockResolvedValueOnce(result(0))
    await drainLegacyWslRuntimeAuth({
      distro: 'Ubuntu',
      guestHomeLinuxPath: '/home/alice',
      legacyPanePresent: false,
      resolveDestination: () => ({
        authContents: '{"tokens":{"expires_at":3000}}\n',
        linuxHomePath: '/home/alice/.codex'
      })
    })
    expect(runWslProcessMock.mock.calls[1][0].args.slice(-3)).toEqual(['0', '1', 'missing'])
  })

  it('does not expose captured auth output when the guest apply fails', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(result(0, inspection(SOURCE)))
      .mockResolvedValueOnce(result(45, 'secret-auth-output'))
    const operation = drainLegacyWslRuntimeAuth({
      distro: 'Ubuntu',
      guestHomeLinuxPath: '/home/alice',
      legacyPanePresent: false,
      resolveDestination: () => ({ authContents: STALE, linuxHomePath: '/home/alice/.codex' })
    })
    await expect(operation).rejects.toThrow('Legacy WSL auth drain apply failed (exit 45)')
    await expect(operation).rejects.not.toThrow('secret-auth-output')
  })

  it('coalesces concurrent launches and allows idempotent retries', async () => {
    let release!: (value: ReturnType<typeof result>) => void
    runWslProcessMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const options = {
      distro: 'Ubuntu',
      guestHomeLinuxPath: '/home/alice',
      legacyPanePresent: true,
      resolveDestination: () => null
    }
    startLegacyWslRuntimeAuthDrain(options)
    startLegacyWslRuntimeAuthDrain(options)
    await Promise.resolve()
    expect(runWslProcessMock).toHaveBeenCalledTimes(1)
    release(result(0, inspection(SOURCE)))
    runWslProcessMock.mockResolvedValueOnce(result(0, inspection(SOURCE)))
    await vi.waitFor(() => {
      startLegacyWslRuntimeAuthDrain(options)
      expect(runWslProcessMock).toHaveBeenCalledTimes(2)
    })
  })

  it('is idempotent when the completion marker is already present', async () => {
    runWslProcessMock.mockResolvedValueOnce(result(20))
    const resolveDestination = vi.fn()
    await expect(
      drainLegacyWslRuntimeAuth({
        distro: 'Ubuntu',
        guestHomeLinuxPath: '/home/alice',
        legacyPanePresent: false,
        resolveDestination
      })
    ).resolves.toBe('complete')
    expect(resolveDestination).not.toHaveBeenCalled()
  })

  it('does not share completion across distinct guest homes in one distro', async () => {
    runWslProcessMock.mockResolvedValue(result(20))
    const options = {
      distro: 'Ubuntu',
      legacyPanePresent: false,
      resolveDestination: vi.fn()
    }
    startLegacyWslRuntimeAuthDrain({ ...options, guestHomeLinuxPath: '/home/alice' })
    await vi.waitFor(() => expect(runWslProcessMock).toHaveBeenCalledTimes(1))
    startLegacyWslRuntimeAuthDrain({ ...options, guestHomeLinuxPath: '/home/bob' })
    await vi.waitFor(() => expect(runWslProcessMock).toHaveBeenCalledTimes(2))
  })
})
