import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { teaExecFileAsyncMock } = vi.hoisted(() => ({ teaExecFileAsyncMock: vi.fn() }))

vi.mock('../git/runner', () => ({ teaExecFileAsync: teaExecFileAsyncMock }))

import {
  _resetTeaKnownHostsCache,
  getTeaKnownHosts,
  getTeaKnownLogins,
  KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS,
  rememberTeaKnownHosts
} from './gitea-known-host-probe'
import { NEGATIVE_ENTRY_TTL_MS } from '../git/remote-ref-probe-cache'

const LOCAL_PROBE_OPTIONS = { timeout: 10_000, allowDefaultWslFallback: false }

function loginList(rows: readonly Record<string, unknown>[]): { stdout: string; stderr: string } {
  return { stdout: JSON.stringify(rows), stderr: '' }
}

describe('getTeaKnownLogins', () => {
  beforeEach(() => {
    teaExecFileAsyncMock.mockReset()
    _resetTeaKnownHostsCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses tea login list json, including string booleans from tea table output', async () => {
    teaExecFileAsyncMock.mockResolvedValueOnce(
      loginList([
        {
          name: 'codeberg',
          url: 'https://codeberg.org',
          ssh_host: 'codeberg.org',
          user: 'alice',
          default: 'true'
        },
        {
          name: 'internal',
          url: 'https://gitea.internal:3000',
          ssh_host: 'gitea.internal',
          user: 'bob',
          default: 'false'
        },
        {
          name: 'subpath',
          url: 'https://example.com/git',
          ssh_host: 'example.com',
          user: 'carol',
          default: false
        }
      ])
    )

    await expect(getTeaKnownLogins()).resolves.toEqual([
      {
        name: 'codeberg',
        url: 'https://codeberg.org',
        host: 'codeberg.org',
        sshHost: 'codeberg.org',
        user: 'alice',
        isDefault: true
      },
      {
        name: 'internal',
        url: 'https://gitea.internal:3000',
        host: 'gitea.internal:3000',
        sshHost: 'gitea.internal',
        user: 'bob',
        isDefault: false
      },
      {
        name: 'subpath',
        url: 'https://example.com/git',
        host: 'example.com/git',
        sshHost: 'example.com',
        user: 'carol',
        isDefault: false
      }
    ])
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(
      ['login', 'list', '-o', 'json'],
      LOCAL_PROBE_OPTIONS
    )
  })

  it('preserves a custom port and a subpath on the host identity', async () => {
    teaExecFileAsyncMock.mockResolvedValueOnce(
      loginList([
        {
          name: 'ported',
          url: 'https://gitea.internal:3000/org',
          ssh_host: 'gitea.internal',
          user: 'bob',
          default: 'false'
        }
      ])
    )

    await expect(getTeaKnownHosts()).resolves.toEqual(['gitea.internal:3000/org'])
  })

  it('passes WSL distro and admission tier through to the login probe', async () => {
    teaExecFileAsyncMock.mockResolvedValueOnce(loginList([]))

    await getTeaKnownLogins(undefined, { wslDistro: 'Ubuntu', admissionTier: 'background' })

    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(['login', 'list', '-o', 'json'], {
      ...LOCAL_PROBE_OPTIONS,
      wslDistro: 'Ubuntu',
      admissionTier: 'background'
    })
  })

  it('caches logins per execution context and coalesces in-flight probes', async () => {
    let resolveProbe: (value: { stdout: string; stderr: string }) => void = () => {}
    teaExecFileAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve
        })
    )

    const probes = Array.from({ length: 8 }, () => getTeaKnownHosts())
    expect(teaExecFileAsyncMock).toHaveBeenCalledTimes(1)
    resolveProbe(
      loginList([
        {
          name: 'codeberg',
          url: 'https://codeberg.org',
          ssh_host: 'codeberg.org',
          user: 'alice',
          default: 'true'
        }
      ])
    )
    const results = await Promise.all(probes)
    expect(results.every((result) => result === results[0])).toBe(true)
    await getTeaKnownHosts()
    expect(teaExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })
})

describe('tea known-host backoff', () => {
  const recovered = loginList([
    {
      name: 'recovered',
      url: 'https://recovered.test',
      ssh_host: 'recovered.test',
      user: 'ada',
      default: 'true'
    }
  ])

  beforeEach(() => {
    _resetTeaKnownHostsCache()
    teaExecFileAsyncMock.mockReset().mockRejectedValue(new Error('keyring locked'))
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('coalesces failures and suppresses repeated polls until the retry boundary', async () => {
    await Promise.all(Array.from({ length: 20 }, () => getTeaKnownHosts()))
    for (let index = 0; index < 20; index++) {
      await getTeaKnownHosts()
    }
    expect(teaExecFileAsyncMock).toHaveBeenCalledTimes(1)
    vi.mocked(Date.now).mockReturnValue(1_000 + KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS - 1)
    await getTeaKnownHosts()
    expect(teaExecFileAsyncMock).toHaveBeenCalledTimes(1)
    vi.mocked(Date.now).mockReturnValue(1_000 + KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS)
    teaExecFileAsyncMock.mockResolvedValueOnce(recovered)
    await expect(getTeaKnownHosts()).resolves.toEqual(['recovered.test'])
    expect(teaExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('doubles the retry delay on repeated failures up to the negative-entry TTL', async () => {
    let now = 1_000
    const retryDelays: number[] = []
    for (let attempt = 0; attempt < 7; attempt++) {
      await getTeaKnownHosts()
      let delay = 0
      while (teaExecFileAsyncMock.mock.calls.length === attempt + 1) {
        delay += 1_000
        vi.mocked(Date.now).mockReturnValue(now + delay)
        await getTeaKnownHosts()
      }
      retryDelays.push(delay)
      now += delay
    }
    const initial = KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS
    expect(retryDelays.slice(0, 4)).toEqual([initial, initial * 2, initial * 4, initial * 8])
    expect(retryDelays.at(-1)).toBe(NEGATIVE_ENTRY_TTL_MS)
  })

  it('lets an authentication refresh retry immediately', async () => {
    await getTeaKnownHosts()
    rememberTeaKnownHosts([])
    teaExecFileAsyncMock.mockResolvedValueOnce(recovered)
    await expect(getTeaKnownHosts()).resolves.toEqual(['recovered.test'])
    expect(teaExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('isolates failures by execution context', async () => {
    for (let index = 0; index < 2; index++) {
      await getTeaKnownHosts()
      await getTeaKnownHosts(undefined, { wslDistro: 'Ubuntu' })
      await getTeaKnownHosts(undefined, { wslDistro: 'Debian' })
      await getTeaKnownHosts('connection')
    }
    expect(teaExecFileAsyncMock).toHaveBeenCalledTimes(4)
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(['login', 'list', '-o', 'json'], {
      timeout: 10_000,
      wslDistro: 'Ubuntu',
      allowDefaultWslFallback: false
    })
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(
      ['login', 'list', '-o', 'json'],
      expect.objectContaining({ timeout: 10_000 })
    )
  })
})
