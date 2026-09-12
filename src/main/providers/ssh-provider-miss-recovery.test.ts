import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE,
  requireSshFilesystemProvider
} from './ssh-filesystem-dispatch'
import { SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE, requireSshGitProvider } from './ssh-git-dispatch'
import {
  recoverSshProviderMiss,
  scheduleSshProviderMissRecovery,
  setSshProviderMissRecovery,
  sshProviderMissRecoveryThrottleEntryCount
} from './ssh-provider-miss-recovery'

const TARGET = 'runtime-ssh-orca-1'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  setSshProviderMissRecovery(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('requireSshGitProvider / requireSshFilesystemProvider on a miss', () => {
  // Why these two sites: they are where the reporter's second string ("Remote connection
  // dropped…") comes from, reached by every git/file operation after an app restart. The
  // call still fails — callers poll or retry — but the owner is asked to re-attach so the
  // next attempt finds the provider, exactly as the PTY spawn path does synchronously.
  it.each([
    ['git', () => requireSshGitProvider(TARGET), SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE],
    [
      'filesystem',
      () => requireSshFilesystemProvider(TARGET),
      SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
    ]
  ])('asks the installed recovery to re-attach on a %s provider miss', (_kind, call, message) => {
    const recovery = vi.fn(() => Promise.resolve())
    setSshProviderMissRecovery(recovery)

    expect(call).toThrow(message)

    expect(recovery).toHaveBeenCalledWith(TARGET)
  })

  it('throws the unchanged message when no recovery is installed', () => {
    expect(() => requireSshGitProvider(TARGET)).toThrow(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
    expect(() => requireSshFilesystemProvider(TARGET)).toThrow(
      SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
    )
  })
})

describe('scheduleSshProviderMissRecovery', () => {
  it('throttles repeated misses for one connection while a re-attach is recent', () => {
    // Why: git status and file watches poll; without this a failing relay would be dialed
    // once per poll. Distinct connections are throttled independently.
    const recovery = vi.fn(() => Promise.resolve())
    setSshProviderMissRecovery(recovery)

    scheduleSshProviderMissRecovery(TARGET)
    scheduleSshProviderMissRecovery(TARGET)
    scheduleSshProviderMissRecovery('runtime-ssh-orca-2')
    expect(recovery).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(5_000)
    scheduleSshProviderMissRecovery(TARGET)
    expect(recovery).toHaveBeenCalledTimes(3)
  })

  it('logs, rather than surfaces, a failed background re-attach', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setSshProviderMissRecovery(() => Promise.reject(new Error('connect ECONNREFUSED')))

    scheduleSshProviderMissRecovery(TARGET)
    await vi.runAllTimersAsync()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'))
  })

  it('lets a declined connection fall through without scheduling anything', () => {
    const recovery = vi.fn(() => undefined)
    setSshProviderMissRecovery(recovery)
    scheduleSshProviderMissRecovery('ssh-user-target')
    expect(recovery).toHaveBeenCalledWith('ssh-user-target')
    expect(recoverSshProviderMiss('ssh-user-target')).toBeUndefined()
  })

  it('keeps re-consulting the owner for declined connections and retains none of them', () => {
    // Why: these dispatchers are called with every SSH connection id in the app, most of
    // which no owner claims. A declined id was never dialed, so there is nothing to back
    // off from — throttling it would both retain it forever and swallow the next miss.
    const recovery = vi.fn(() => undefined)
    setSshProviderMissRecovery(recovery)

    scheduleSshProviderMissRecovery('ssh-user-a')
    scheduleSshProviderMissRecovery('ssh-user-a')
    scheduleSshProviderMissRecovery('ssh-user-b')

    expect(recovery).toHaveBeenCalledTimes(3)
    expect(sshProviderMissRecoveryThrottleEntryCount()).toBe(0)
  })

  it('prunes claimed connections once their throttle interval has passed', () => {
    setSshProviderMissRecovery(() => Promise.resolve())

    scheduleSshProviderMissRecovery('runtime-ssh-orca-1')
    scheduleSshProviderMissRecovery('runtime-ssh-orca-2')
    expect(sshProviderMissRecoveryThrottleEntryCount()).toBe(2)

    vi.advanceTimersByTime(5_000)
    scheduleSshProviderMissRecovery('runtime-ssh-orca-3')

    expect(sshProviderMissRecoveryThrottleEntryCount()).toBe(1)
  })
})
