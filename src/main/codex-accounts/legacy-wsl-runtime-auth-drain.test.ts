import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runWslProcessMock } = vi.hoisted(() => ({ runWslProcessMock: vi.fn() }))

vi.mock('../wsl/wsl-runner', () => ({
  runWslProcess: runWslProcessMock
}))

import {
  _internals,
  drainLegacyWslRuntimeAuth,
  startLegacyWslRuntimeAuthDrain
} from './legacy-wsl-runtime-auth-drain'
import { readWslCodexAuths } from './wsl-codex-auth-batch-reader'

const SOURCE_AUTH = '{"tokens":{"expires_at":2000}}\n'
const STALE_AUTH = '{"tokens":{"expires_at":1000}}\n'
const NEWER_AUTH = '{"tokens":{"expires_at":3000}}\n'

function inspection(auth: string, credentials?: string): string {
  return [
    Buffer.from(auth).toString('base64'),
    credentials === undefined ? 'missing' : 'present',
    credentials === undefined ? '' : Buffer.from(credentials).toString('base64')
  ].join('\n')
}

function result(code: number, stdout = '') {
  return {
    code,
    stdout,
    stderr: '',
    timedOut: false,
    environmentResolved: true
  }
}

describe('legacy WSL runtime auth drain', () => {
  beforeEach(() => {
    runWslProcessMock.mockReset()
    _internals.resetDrainQueue()
  })

  it('promotes fresher auth guest-side while a legacy pane remains', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(result(0, inspection(SOURCE_AUTH)))
      .mockResolvedValueOnce(result(0))
    const resolveDestination = vi.fn(() => ({
      authContents: STALE_AUTH,
      linuxHomePath: '/home/alice/.local/share/orca/codex-accounts/account-1/home'
    }))
    await drainLegacyWslRuntimeAuth({
      distro: 'Ubuntu',
      guestHomeLinuxPath: '/home/alice',
      legacyPanePresent: true,
      resolveDestination
    })

    expect(resolveDestination).toHaveBeenCalledWith(SOURCE_AUTH)
    expect(runWslProcessMock).toHaveBeenCalledTimes(2)
    expect(runWslProcessMock.mock.calls[1]?.[0].args.slice(3)).toEqual([
      '/home/alice/.local/share/orca/codex-accounts/account-1/home',
      expect.any(String),
      expect.any(String),
      '1',
      '0',
      'missing',
      'full'
    ])
    expect(runWslProcessMock.mock.calls[1]?.[0].script).toContain('readlink -f')
    expect(runWslProcessMock.mock.calls[1]?.[0].script).toContain('source_credentials=')
    expect(runWslProcessMock.mock.calls[1]?.[0].script).toContain('chmod 600')
    expect(runWslProcessMock.mock.calls[1]?.[0].timeoutMs).toBe(30_000)
  })

  it('bridges sessions without changing auth when freshness cannot be proven', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(result(0, inspection('{"tokens":{}}\n')))
      .mockResolvedValueOnce(result(0))

    await drainLegacyWslRuntimeAuth({
      distro: 'Ubuntu',
      guestHomeLinuxPath: '/home/alice',
      legacyPanePresent: false,
      resolveDestination: () => ({
        authContents: '{"tokens":{}}\n',
        linuxHomePath: '/home/alice/.codex'
      })
    })

    expect(runWslProcessMock).toHaveBeenCalledTimes(2)
    expect(runWslProcessMock.mock.calls[1]?.[0].args.slice(-4)).toEqual([
      '0',
      '0',
      'missing',
      'full'
    ])
  })

  it('refuses a source with no unique destination', async () => {
    runWslProcessMock.mockResolvedValueOnce(result(0, inspection(SOURCE_AUTH)))

    await drainLegacyWslRuntimeAuth({
      distro: 'Ubuntu',
      guestHomeLinuxPath: '/home/alice',
      legacyPanePresent: false,
      resolveDestination: () => null
    })

    expect(runWslProcessMock).toHaveBeenCalledTimes(1)
  })

  it('retires stale legacy auth only after the last recorded pane exits', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(result(0, inspection(SOURCE_AUTH)))
      .mockResolvedValueOnce(result(0))

    await drainLegacyWslRuntimeAuth({
      distro: 'Ubuntu',
      guestHomeLinuxPath: '/home/alice',
      legacyPanePresent: false,
      resolveDestination: () => ({
        authContents: NEWER_AUTH,
        linuxHomePath: '/home/alice/.codex'
      })
    })

    expect(runWslProcessMock.mock.calls[1]?.[0].args.slice(-4)).toEqual([
      '0',
      '1',
      'missing',
      'full'
    ])
    expect(runWslProcessMock.mock.calls[1]?.[0].timeoutMs).toBe(30_000)
  })

  it('recovers a failed guest apply before resolving the drain as pending', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(result(0, inspection(SOURCE_AUTH)))
      .mockResolvedValueOnce(result(45))
      .mockResolvedValueOnce(result(0, inspection(SOURCE_AUTH)))

    await expect(
      drainLegacyWslRuntimeAuth({
        distro: 'Ubuntu',
        guestHomeLinuxPath: '/home/alice',
        legacyPanePresent: false,
        resolveDestination: () => ({
          authContents: NEWER_AUTH,
          linuxHomePath: '/home/alice/.codex'
        })
      })
    ).resolves.toBe('pending')

    expect(runWslProcessMock).toHaveBeenCalledTimes(3)
    expect(runWslProcessMock.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        script: _internals.inspectLegacyAuthScript,
        timeoutMs: 5_000
      })
    )
  })

  it('rejects an awaited launch drain when guest recovery cannot finish', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(result(0, inspection(SOURCE_AUTH)))
      .mockResolvedValueOnce(result(45))
      .mockResolvedValueOnce(result(46))

    await expect(
      startLegacyWslRuntimeAuthDrain(
        {
          distro: 'Ubuntu',
          guestHomeLinuxPath: '/home/alice',
          legacyPanePresent: false,
          resolveDestination: () => ({
            authContents: NEWER_AUTH,
            linuxHomePath: '/home/alice/.codex'
          })
        },
        { throwOnFailure: true }
      )
    ).rejects.toThrow('Legacy WSL auth drain recover failed')
  })

  it('keeps an absent source retryable while the legacy home remains', async () => {
    runWslProcessMock.mockResolvedValueOnce(result(21))

    await drainLegacyWslRuntimeAuth({
      distro: 'Ubuntu',
      guestHomeLinuxPath: '/home/alice',
      legacyPanePresent: false,
      resolveDestination: vi.fn()
    })

    expect(runWslProcessMock).toHaveBeenCalledTimes(1)
  })

  it('does nothing after the guest-side completion marker is present', async () => {
    runWslProcessMock.mockResolvedValueOnce(result(20))
    const resolveDestination = vi.fn()

    await drainLegacyWslRuntimeAuth({
      distro: 'Ubuntu',
      guestHomeLinuxPath: '/home/alice',
      legacyPanePresent: false,
      resolveDestination
    })

    expect(resolveDestination).not.toHaveBeenCalled()
    expect(runWslProcessMock).toHaveBeenCalledTimes(1)
  })

  it('marks an absent legacy home complete after every legacy pane exits', async () => {
    runWslProcessMock.mockResolvedValueOnce(result(22)).mockResolvedValueOnce(result(0))

    await drainLegacyWslRuntimeAuth({
      distro: 'Ubuntu',
      guestHomeLinuxPath: '/home/alice',
      legacyPanePresent: false,
      resolveDestination: vi.fn()
    })

    expect(runWslProcessMock).toHaveBeenCalledTimes(2)
    expect(runWslProcessMock.mock.calls[1]?.[0].args).toEqual([
      '/home/alice/.local/share/orca/codex-runtime-home/home',
      '/home/alice/.local/share/orca/codex-runtime-home/active/wsl/home',
      '/home/alice/.local/share/orca/codex-runtime-home/direct-home-auth-drain-v1.json'
    ])
  })

  it('coalesces concurrent drain triggers instead of queueing every poll', async () => {
    runWslProcessMock.mockImplementation(() => new Promise(() => {}))
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
  })

  it('bounds sequential pending launches to recent session dates', async () => {
    runWslProcessMock.mockImplementation((options: { script: string }) =>
      Promise.resolve(
        options.script === _internals.inspectLegacyAuthScript
          ? result(0, inspection(SOURCE_AUTH))
          : result(0)
      )
    )
    const options = {
      distro: 'Ubuntu',
      guestHomeLinuxPath: '/home/alice',
      legacyPanePresent: true,
      resolveDestination: () => ({
        authContents: STALE_AUTH,
        linuxHomePath: '/home/alice/.local/share/orca/codex-accounts/account-1/home'
      })
    }

    await startLegacyWslRuntimeAuthDrain(options, { throwOnFailure: true })
    await startLegacyWslRuntimeAuthDrain(options, { throwOnFailure: true })
    await startLegacyWslRuntimeAuthDrain(
      { ...options, legacyPanePresent: false },
      { throwOnFailure: true }
    )

    const applyCalls = runWslProcessMock.mock.calls.filter(
      ([call]) => call.script === _internals.applyLegacyAuthScript
    )
    expect(applyCalls).toHaveLength(3)
    expect(applyCalls.map(([call]) => call.args.at(-1))).toEqual(['full', 'recent', 'full'])
    expect(applyCalls.map(([call]) => call.timeoutMs)).toEqual([30_000, 5_000, 30_000])
  })

  it('reads every candidate home in one bounded guest process', async () => {
    runWslProcessMock.mockResolvedValueOnce(
      result(
        0,
        [`present:${Buffer.from(SOURCE_AUTH).toString('base64')}`, 'missing', 'unreadable'].join(
          '\n'
        )
      )
    )

    await expect(
      readWslCodexAuths('Ubuntu', ['/home/alice/.codex-a', '/home/alice/.codex-b', '/bad'])
    ).resolves.toEqual([
      { kind: 'present', contents: SOURCE_AUTH },
      { kind: 'missing' },
      { kind: 'unreadable' }
    ])
    expect(runWslProcessMock).toHaveBeenCalledTimes(1)
    expect(runWslProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['/home/alice/.codex-a', '/home/alice/.codex-b', '/bad'],
        maxOutputBytes: 2 * 1024 * 1024,
        timeoutMs: 5_000
      })
    )
  })
})
