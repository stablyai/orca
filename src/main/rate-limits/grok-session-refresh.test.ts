import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { hostShellEnvironment } from '../runtime/structured-agent-shell-environment'
import { readGrokAuthSession, type GrokAuthReadResult } from './grok-auth'
import type * as GrokAuthModule from './grok-auth'
import {
  readGrokAuthForUsage,
  refreshGrokAccessTokenViaSessionsList,
  resetGrokSessionRefreshForTests
} from './grok-session-refresh'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
vi.mock('../ipc/command-path-resolver', () => ({ resolveCommandOnLocalPath: vi.fn() }))
vi.mock('../runtime/structured-agent-shell-environment', () => ({ hostShellEnvironment: vi.fn() }))
vi.mock('./grok-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof GrokAuthModule>()),
  readGrokAuthSession: vi.fn()
}))

const ENV = { PATH: '/usr/bin' }
const PROCESS_RESULT = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }

function session(expiresAtMs: number | null, accessToken = 'token'): GrokAuthReadResult {
  return {
    status: 'ok',
    session: {
      accessToken,
      userId: null,
      email: null,
      teamId: null,
      expiresAtMs,
      oidcClientId: null
    }
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-31T12:00:00.000Z'))
  vi.stubEnv('GROK_HOME', undefined)
  vi.mocked(hostShellEnvironment).mockResolvedValue(ENV)
  vi.mocked(resolveCommandOnLocalPath).mockResolvedValue('/usr/bin/grok')
  vi.mocked(runProcess).mockResolvedValue(PROCESS_RESULT)
})

afterEach(() => {
  resetGrokSessionRefreshForTests()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('refreshGrokAccessTokenViaSessionsList', () => {
  it('runs grok sessions list on the login-shell path with bounded output and cancellation', async () => {
    const controller = new AbortController()
    await refreshGrokAccessTokenViaSessionsList(controller.signal)

    expect(resolveCommandOnLocalPath).toHaveBeenCalledWith('grok', {
      env: { ...ENV, GROK_HOME: join(homedir(), '.grok') }
    })
    expect(runProcess).toHaveBeenCalledWith({
      program: '/usr/bin/grok',
      args: ['sessions', 'list'],
      env: { ...ENV, GROK_HOME: join(homedir(), '.grok') },
      cwd: homedir(),
      timeoutMs: 20_000,
      maxOutputBytes: 64 * 1024,
      signal: controller.signal
    })
  })

  it.each([undefined, '', '   ', 'relative/grok'])(
    'uses the app default home instead of a shell-only override when GROK_HOME is %j',
    async (grokHome) => {
      vi.stubEnv('GROK_HOME', grokHome)
      vi.mocked(hostShellEnvironment).mockResolvedValue({
        ...ENV,
        GROK_HOME: join(homedir(), 'shell-grok')
      })
      await refreshGrokAccessTokenViaSessionsList()

      expect(runProcess).toHaveBeenCalledWith(
        expect.objectContaining({ env: { ...ENV, GROK_HOME: join(homedir(), '.grok') } })
      )
    }
  )

  it('keeps the normalized app-level GROK_HOME ahead of the login shell', async () => {
    const grokHome = join(homedir(), 'app-grok')
    vi.stubEnv('GROK_HOME', `  ${grokHome}  `)
    vi.mocked(hostShellEnvironment).mockResolvedValue({
      ...ENV,
      GROK_HOME: join(homedir(), 'shell-grok')
    })
    await refreshGrokAccessTokenViaSessionsList()

    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({ env: { ...ENV, GROK_HOME: grokHome } })
    )
  })

  it('does not spawn a missing CLI', async () => {
    vi.mocked(resolveCommandOnLocalPath).mockResolvedValue(null)
    await refreshGrokAccessTokenViaSessionsList()

    expect(resolveCommandOnLocalPath).toHaveBeenCalled()
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('releases shared usage reads when command lookup never settles and permits a debounced retry', async () => {
    const lookup = Promise.withResolvers<string | null>()
    const started = Promise.withResolvers<void>()
    vi.mocked(resolveCommandOnLocalPath).mockImplementationOnce(() => {
      started.resolve()
      return lookup.promise
    })
    const stale = session(Date.now() + 60_000)
    vi.mocked(readGrokAuthSession).mockReturnValue(stale)
    const settled = vi.fn()
    const first = readGrokAuthForUsage({ authReadResult: stale }).then(settled)
    const second = readGrokAuthForUsage({ authReadResult: stale }).then(settled)
    await started.promise

    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).not.toHaveBeenCalled()
    expect(resolveCommandOnLocalPath).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([first, second])
    expect(settled).toHaveBeenCalledTimes(2)
    expect(settled).toHaveBeenCalledWith(stale)
    expect(runProcess).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    await refreshGrokAccessTokenViaSessionsList()
    expect(resolveCommandOnLocalPath).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(40_000)
    await refreshGrokAccessTokenViaSessionsList()
    expect(resolveCommandOnLocalPath).toHaveBeenCalledTimes(2)
    expect(runProcess).toHaveBeenCalledTimes(1)
  })

  it.each(['timeout', 'abort'] as const)(
    'does not spawn a late command lookup after setup %s',
    async (ending) => {
      const lookup = Promise.withResolvers<string | null>()
      const started = Promise.withResolvers<void>()
      const controller = new AbortController()
      vi.mocked(resolveCommandOnLocalPath).mockImplementationOnce(() => {
        started.resolve()
        return lookup.promise
      })
      const first = refreshGrokAccessTokenViaSessionsList(controller.signal)
      const second = refreshGrokAccessTokenViaSessionsList()
      await started.promise

      if (ending === 'timeout') {
        await vi.advanceTimersByTimeAsync(10_000)
      } else {
        controller.abort()
      }
      await Promise.all([first, second])
      expect(runProcess).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)

      await vi.advanceTimersByTimeAsync(50_000)
      await refreshGrokAccessTokenViaSessionsList()
      expect(runProcess).toHaveBeenCalledTimes(1)
      lookup.resolve('/late/grok')
      await vi.advanceTimersByTimeAsync(0)
      expect(runProcess).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['timeout', 'abort'] as const)(
    'bounds shell environment preparation on %s',
    async (ending) => {
      const environment = Promise.withResolvers<NodeJS.ProcessEnv>()
      const started = Promise.withResolvers<void>()
      const controller = new AbortController()
      vi.mocked(hostShellEnvironment).mockImplementationOnce(() => {
        started.resolve()
        return environment.promise
      })
      const refresh = refreshGrokAccessTokenViaSessionsList(controller.signal)
      await started.promise

      if (ending === 'timeout') {
        await vi.advanceTimersByTimeAsync(10_000)
      } else {
        controller.abort()
      }
      await refresh
      expect(resolveCommandOnLocalPath).not.toHaveBeenCalled()
      expect(runProcess).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('runs a command resolved before the setup deadline and clears the setup timer', async () => {
    const lookup = Promise.withResolvers<string | null>()
    const started = Promise.withResolvers<void>()
    vi.mocked(resolveCommandOnLocalPath).mockImplementationOnce(() => {
      started.resolve()
      return lookup.promise
    })
    const refresh = refreshGrokAccessTokenViaSessionsList()
    await started.promise

    await vi.advanceTimersByTimeAsync(9_999)
    expect(runProcess).not.toHaveBeenCalled()
    lookup.resolve('/resolved/grok')
    await refresh
    expect(runProcess).toHaveBeenCalledWith(expect.objectContaining({ program: '/resolved/grok' }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares one in-flight CLI run', async () => {
    const run = Promise.withResolvers<Awaited<ReturnType<typeof runProcess>>>()
    const started = Promise.withResolvers<void>()
    vi.mocked(runProcess).mockImplementation(() => {
      started.resolve()
      return run.promise
    })
    const first = refreshGrokAccessTokenViaSessionsList()
    const second = refreshGrokAccessTokenViaSessionsList()
    await started.promise
    expect(runProcess).toHaveBeenCalledTimes(1)

    run.resolve(PROCESS_RESULT)
    await Promise.all([first, second])
    expect(runProcess).toHaveBeenCalledTimes(1)
  })

  it('debounces CLI runs without blocking the next scheduled retry', async () => {
    await refreshGrokAccessTokenViaSessionsList()
    await refreshGrokAccessTokenViaSessionsList()
    expect(runProcess).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60_000)
    await refreshGrokAccessTokenViaSessionsList()
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it('does not resolve or spawn the CLI after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await refreshGrokAccessTokenViaSessionsList(controller.signal)

    expect(hostShellEnvironment).not.toHaveBeenCalled()
    expect(runProcess).not.toHaveBeenCalled()
  })
})

describe('readGrokAuthForUsage', () => {
  it('re-reads auth.json after refreshing a near-expiry token', async () => {
    const stale = session(Date.now() + 60_000, 'stale')
    const fresh = session(Date.now() + 60 * 60 * 1000, 'fresh')
    vi.mocked(readGrokAuthSession).mockReturnValue(fresh)

    const result = await readGrokAuthForUsage({ authReadResult: stale })

    expect(runProcess).toHaveBeenCalledTimes(1)
    expect(readGrokAuthSession).toHaveBeenCalledTimes(1)
    expect(result).toBe(fresh)
  })

  it.each([
    { code: 1, timedOut: false },
    { code: null, timedOut: true }
  ])('uses refreshed auth even when the CLI reports %o', async (failure) => {
    const stale = session(Date.now() + 60_000, 'stale')
    const fresh = session(Date.now() + 60 * 60 * 1000, 'fresh')
    vi.mocked(runProcess).mockResolvedValue({ ...PROCESS_RESULT, ...failure })
    vi.mocked(readGrokAuthSession).mockReturnValue(fresh)

    const result = await readGrokAuthForUsage({ authReadResult: stale })

    expect(runProcess).toHaveBeenCalledTimes(1)
    expect(readGrokAuthSession).toHaveBeenCalledTimes(1)
    expect(result).toBe(fresh)
  })

  it('still reads auth when the CLI cannot start', async () => {
    const stale = session(Date.now() + 60_000)
    vi.mocked(runProcess).mockRejectedValue(new Error('spawn failed'))
    vi.mocked(readGrokAuthSession).mockReturnValue(stale)

    const result = await readGrokAuthForUsage({ authReadResult: stale })

    expect(runProcess).toHaveBeenCalledTimes(1)
    expect(readGrokAuthSession).toHaveBeenCalledTimes(1)
    expect(result).toBe(stale)
  })

  it('leaves a far-from-expiry snapshot untouched', async () => {
    const current = session(Date.now() + 2 * 60 * 60 * 1000)

    const result = await readGrokAuthForUsage({ authReadResult: current })

    expect(result).toBe(current)
    expect(readGrokAuthSession).not.toHaveBeenCalled()
    expect(hostShellEnvironment).not.toHaveBeenCalled()
    expect(runProcess).not.toHaveBeenCalled()
  })
})
