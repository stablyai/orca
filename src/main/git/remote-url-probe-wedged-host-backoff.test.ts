import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getSshGitProviderMock, gitExecFileAsyncMock } = vi.hoisted(() => ({
  getSshGitProviderMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: () => 0,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'SSH Git provider unavailable'
}))

vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import {
  _getGitHostProbeState,
  _resetGitHostProbeBreaker,
  GIT_HOST_PROBE_HEALTHY_CONCURRENCY
} from './git-host-probe-breaker'
import {
  assertRemoteUrlReadable,
  isTransientGitProbeError,
  readRemoteUrl,
  REMOTE_URL_PROBE_TIMEOUT_MS
} from './remote-url-probe'
import {
  resetWslLinkedWorktreeGitRoutingForTests,
  seedWslLinkedWorktreeGitRoutingForTests
} from './wsl-linked-worktree-git-routing'

/**
 * Crash f2521868: a wedged WSL distro answered nothing for two hours while every
 * git-backed panel stayed stale. In the final hour that cost 431 `git remote
 * get-url` calls, 414 of them dying on the deadline, peaking at 15 concurrent
 * `wsl.exe` children — and it got worse over time, because each probe settles on
 * its deadline, so the in-flight coalescer drops it and the next poll re-issues.
 */
const WEDGED_DISTRO = 'Ubuntu-24.04'
const WEDGED_HOST_KEY = 'wsl:ubuntu-24.04'
const WSL_REPO = `\\\\wsl$\\${WEDGED_DISTRO}\\home\\dev\\orca`
const POLL_INTERVAL_MS = 10_000
const INCIDENT_WINDOW_MS = 60 * 60_000
const REPORTED_PEAK_CONCURRENCY = 15

let virtualNowMs = 0

function advanceTo(nextMs: number): void {
  virtualNowMs = nextMs
  vi.setSystemTime(virtualNowMs)
}

function wslTimeout(): Error {
  return new Error('Error: wsl.exe timed out.')
}

/** Every spawn burns its full deadline, which is what the report recorded. */
function wedgeHost(spawns: number[]): void {
  gitExecFileAsyncMock.mockImplementation(async () => {
    spawns.push(virtualNowMs)
    advanceTo(virtualNowMs + REMOTE_URL_PROBE_TIMEOUT_MS)
    throw wslTimeout()
  })
}

async function pollWslRepo(): Promise<'answered' | 'unavailable'> {
  try {
    await assertRemoteUrlReadable({ repoPath: WSL_REPO, wslDistro: WEDGED_DISTRO })
    return 'answered'
  } catch {
    return 'unavailable'
  }
}

describe('remote URL probe against a wedged host (crash f2521868)', () => {
  beforeEach(() => {
    getSshGitProviderMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    _resetGitHostProbeBreaker()
    resetWslLinkedWorktreeGitRoutingForTests()
    vi.useFakeTimers()
    advanceTo(1_700_000_000_000)
  })

  afterEach(() => {
    resetWslLinkedWorktreeGitRoutingForTests()
    vi.useRealTimers()
  })

  it('stops hammering a wedged distro, then fully restores it on one success', async () => {
    const spawns: number[] = []
    wedgeHost(spawns)

    const startedAtMs = virtualNowMs
    while (virtualNowMs - startedAtMs < INCIDENT_WINDOW_MS) {
      const pollStartedAtMs = virtualNowMs
      expect(await pollWslRepo()).toBe('unavailable')
      // A blocked poll costs nothing, so the next one lands on its own cadence.
      advanceTo(Math.max(virtualNowMs, pollStartedAtMs + POLL_INTERVAL_MS))
    }

    // The report's hour was 431 calls; a poll every 10s over the same hour now
    // spawns 27, because the backoff converges to one deadline per 150s.
    expect(spawns.length).toBe(27)

    const spawnsInBucket = (bucket: number): number =>
      spawns.filter(
        (at) =>
          at >= startedAtMs + bucket * 10 * 60_000 && at < startedAtMs + (bucket + 1) * 10 * 60_000
      ).length
    // The report's buckets escalated (44 -> 68 -> 125) before the user gave up.
    // "problem infinitly repeat" is disproved by a tail no worse than the head.
    expect([0, 1, 2, 3, 4, 5].map(spawnsInBucket)).toEqual([7, 4, 4, 4, 4, 4])

    // Recovery is unattended: no restart, no user action, just the host answering.
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'git@github.com:acme/orca.git\n' })
    advanceTo(virtualNowMs + 2 * 60_000)
    expect(await pollWslRepo()).toBe('answered')

    gitExecFileAsyncMock.mockClear()
    for (let poll = 0; poll < 5; poll += 1) {
      expect(await pollWslRepo()).toBe('answered')
    }
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(5)
  })

  it('collapses the fan-out the report peaked at, and restores it after recovery', async () => {
    let concurrent = 0
    let peakConcurrent = 0
    const outstanding: (() => void)[] = []
    gitExecFileAsyncMock.mockImplementation(async () => {
      concurrent += 1
      peakConcurrent = Math.max(peakConcurrent, concurrent)
      await new Promise<void>((resume) => outstanding.push(resume))
      concurrent -= 1
      throw wslTimeout()
    })

    const firstWave = Array.from({ length: REPORTED_PEAK_CONCURRENCY }, () => pollWslRepo())
    await vi.advanceTimersByTimeAsync(0)
    expect(peakConcurrent).toBe(GIT_HOST_PROBE_HEALTHY_CONCURRENCY)
    while (outstanding.length > 0) {
      outstanding.pop()?.()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(await Promise.all(firstWave)).toEqual(firstWave.map(() => 'unavailable'))
    // Every later probe in the wave was serialized behind the failing host.
    expect(peakConcurrent).toBe(GIT_HOST_PROBE_HEALTHY_CONCURRENCY)

    const spawns: number[] = []
    wedgeHost(spawns)
    const secondWave = Array.from({ length: REPORTED_PEAK_CONCURRENCY }, () => pollWslRepo())
    expect(await Promise.all(secondWave)).toEqual(secondWave.map(() => 'unavailable'))
    expect(spawns).toEqual([])

    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'git@github.com:acme/orca.git\n' })
    advanceTo(virtualNowMs + 5 * 60_000)
    expect(await pollWslRepo()).toBe('answered')

    gitExecFileAsyncMock.mockClear()
    const healthyWave = Array.from({ length: REPORTED_PEAK_CONCURRENCY }, () => pollWslRepo())
    expect(await Promise.all(healthyWave)).toEqual(healthyWave.map(() => 'answered'))
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(REPORTED_PEAK_CONCURRENCY)
  })

  it('keeps the wedged distro from gating repos on hosts that are answering', async () => {
    const spawns: number[] = []
    wedgeHost(spawns)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await pollWslRepo()).toBe('unavailable')
    }
    spawns.length = 0
    expect(await pollWslRepo()).toBe('unavailable')
    expect(spawns).toEqual([])

    // A native repo, and a repo on a different distro, still probe immediately.
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'git@github.com:acme/orca.git\n' })
    await expect(readRemoteUrl({ repoPath: 'C:/repos/orca' }, 'origin')).resolves.toContain(
      'github.com'
    )
    await expect(
      readRemoteUrl(
        { repoPath: '\\\\wsl$\\Debian\\home\\dev\\orca', wslDistro: 'Debian' },
        'origin'
      )
    ).resolves.toContain('github.com')
  })

  it('reports a suppressed probe as unavailable, never as a cacheable answer', async () => {
    const spawns: number[] = []
    wedgeHost(spawns)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await pollWslRepo()
    }

    await expect(
      readRemoteUrl({ repoPath: WSL_REPO, wslDistro: WEDGED_DISTRO }, 'origin')
    ).rejects.toSatisfy(isTransientGitProbeError)
  })
  /**
   * A Windows-drive worktree linked into a WSL repo carries the distro as a hint
   * but runs *host* git, so keying the probe by the hint would let its instant
   * successes reset the wedged distro's streak on every poll — the breaker would
   * never open and the storm would be back at full width.
   */
  it('keys a Windows-drive linked worktree to the host git that actually runs it', async () => {
    const linkedWorktree = 'C:\\worktrees\\orca'
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      seedWslLinkedWorktreeGitRoutingForTests(linkedWorktree)
      const spawns: number[] = []
      gitExecFileAsyncMock.mockImplementation(async (_args: string[], options: { cwd: string }) => {
        if (options.cwd === linkedWorktree) {
          return { stdout: 'git@github.com:acme/orca.git\n' }
        }
        spawns.push(virtualNowMs)
        advanceTo(virtualNowMs + REMOTE_URL_PROBE_TIMEOUT_MS)
        throw wslTimeout()
      })

      for (let cycle = 0; cycle < 20; cycle += 1) {
        await expect(
          readRemoteUrl({ repoPath: linkedWorktree, wslDistro: WEDGED_DISTRO }, 'origin')
        ).resolves.toContain('github.com')
        expect(await pollWslRepo()).toBe('unavailable')
        advanceTo(virtualNowMs + POLL_INTERVAL_MS)
      }

      expect(_getGitHostProbeState(WEDGED_HOST_KEY)?.blockedUntilMs).toBeGreaterThan(virtualNowMs)
      expect(spawns.length).toBeLessThanOrEqual(GIT_HOST_PROBE_HEALTHY_CONCURRENCY)
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
})
