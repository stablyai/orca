import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probeCodexAuthPresence } from './codex-auth-presence'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import {
  asRateLimitWindow,
  deferred,
  errorProvider,
  FakeRateLimitWindow,
  okProvider,
  resetRateLimitProviderMocks,
  unavailableProvider
} from './rate-limit-service-test-harness'

vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))

vi.mock('./codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('./gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('./kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('./opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('./zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn()
}))

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('./minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('./cursor-auth', () => ({
  readCursorAuthSession: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

describe('Codex usage after external login', () => {
  let home: string
  let service: RateLimitService

  beforeEach(async () => {
    resetRateLimitProviderMocks()
    home = await mkdtemp(join(tmpdir(), 'orca-codex-reauth-'))
    service = new RateLimitService()
    service.setCodexHomePathResolver(() => ({ kind: 'ready', codexHomePath: home }))
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 15))
    vi.mocked(fetchCodexRateLimits).mockImplementation(async (options) => {
      const presence = await probeCodexAuthPresence(options?.codexHomePath, options)
      return presence === 'present'
        ? okProvider('codex', 23)
        : unavailableProvider('codex', 'Codex not signed in')
    })
  })

  afterEach(async () => {
    service.stop()
    vi.restoreAllMocks()
    await rm(home, { recursive: true, force: true })
  })

  it('recovers a fresh unavailable snapshot immediately after auth.json is created', async () => {
    await service.refresh()
    expect(service.getState().codex?.status).toBe('unavailable')
    await writeFile(join(home, 'auth.json'), '{"fixture":"signed-in"}')

    await service.refreshIfStale()

    expect(service.getState().codex?.session?.usedPercent).toBe(23)
    expect(service.getState().codex?.status).toBe('ok')
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
  })

  it('recovers an authentication failure after an atomic credential replacement', async () => {
    await writeFile(join(home, 'auth.json'), '{"fixture":"expired"}')
    await probeCodexAuthPresence(home)
    vi.mocked(fetchCodexRateLimits)
      .mockResolvedValueOnce(errorProvider('codex', 'Token expired'))
      .mockResolvedValueOnce(errorProvider('codex', 'Token expired'))
    await service.refresh()
    await service.refreshIfStale()
    await writeFile(join(home, 'replacement.json'), '{"fixture":"new-token"}')
    await rename(join(home, 'replacement.json'), join(home, 'auth.json'))

    await service.refreshIfStale()

    expect(service.getState().codex?.status).toBe('ok')
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
  })

  it('does not repeat failed probes when credentials have not changed', async () => {
    await service.refresh()
    await service.refreshIfStale()
    await service.refreshIfStale()

    expect(service.getState().codex?.status).toBe('unavailable')
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
  })

  it('does not refresh a healthy account when its CLI rotates credentials', async () => {
    await writeFile(join(home, 'auth.json'), '{"fixture":"first"}')
    await service.refresh()
    await writeFile(join(home, 'auth.json'), '{"fixture":"rotated-token"}')
    await service.refreshIfStale()

    expect(service.getState().codex?.status).toBe('ok')
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
  })

  it('refreshes only the selected runtime home', async () => {
    const otherHome = await mkdtemp(join(tmpdir(), 'orca-codex-other-'))
    try {
      service.setCodexFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      service.setCodexHomePathResolver((target) => ({
        kind: 'ready',
        codexHomePath: target?.runtime === 'wsl' && target.wslDistro === 'Ubuntu' ? home : otherHome
      }))
      await service.refresh()
      await writeFile(join(otherHome, 'auth.json'), '{"fixture":"other-runtime"}')
      await service.refreshIfStale()
      expect(service.getState().codex?.status).toBe('unavailable')
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)

      await writeFile(join(home, 'auth.json'), '{"fixture":"selected-runtime"}')
      await service.refreshIfStale()
      expect(service.getState().codex?.status).toBe('ok')
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
    } finally {
      await rm(otherHome, { recursive: true, force: true })
    }
  })

  it('fences an old-token result and coalesces concurrent post-login refreshes', async () => {
    await service.refresh()
    const oldRequest = deferred<ProviderRateLimits>()
    vi.mocked(fetchCodexRateLimits).mockReturnValueOnce(oldRequest.promise)
    const slowRefresh = service.refreshCodexForTarget()
    await Promise.resolve()
    await writeFile(join(home, 'auth.json'), '{"fixture":"new-login"}')
    const recoveryStarted = deferred<void>()
    const observedErrors: string[] = []
    service.onStateChange((state) => {
      if (state.codex?.error) {
        observedErrors.push(state.codex.error)
      }
      if (state.codex?.status === 'fetching' && !state.codex.error) {
        recoveryStarted.resolve()
      }
    })
    const recovery = service.refreshIfStale()
    const duplicate = service.refreshIfStale()
    await recoveryStarted.promise
    oldRequest.resolve(errorProvider('codex', 'Old-token result'))
    await Promise.all([slowRefresh, recovery, duplicate])

    expect(service.getState().codex?.status).toBe('ok')
    expect(observedErrors).not.toContain('Old-token result')
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(3)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
  })

  it('honors Retry-After even when credentials change', async () => {
    await probeCodexAuthPresence(home)
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce({
      ...errorProvider('codex', 'Rate limited'),
      usageMetadata: { retryAtMs: Date.now() + 60_000 }
    })
    await service.refresh()
    await writeFile(join(home, 'auth.json'), '{"fixture":"new-login"}')
    await service.refreshIfStale()

    expect(service.getState().codex?.error).toBe('Rate limited')
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
  })

  it('does not fall back to host credentials when the selected WSL home is unavailable', async () => {
    await service.refresh()
    service.setCodexFetchTarget({ runtime: 'wsl', wslDistro: 'Offline' })
    service.setCodexHomePathResolver(() => ({ kind: 'skip' }))
    await writeFile(join(home, 'auth.json'), '{"fixture":"host-login"}')
    await service.refreshIfStale()

    expect(service.getState().codex?.status).toBe('unavailable')
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
  })

  it.each(['error', 'unavailable'] as const)(
    'cancels a pending resume check from %s when the service stops',
    async (status) => {
      if (status === 'error') {
        await probeCodexAuthPresence(home)
        vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(
          errorProvider('codex', 'Token expired')
        )
      }
      await service.refresh()
      await writeFile(join(home, 'auth.json'), '{"fixture":"new-login"}')
      const resolvedHome = deferred<{ kind: 'ready'; codexHomePath: string }>()
      service.setCodexHomePathResolver(() => resolvedHome.promise)
      const resume = service.refreshIfStale()
      service.stop()
      resolvedHome.resolve({ kind: 'ready', codexHomePath: home })
      await resume

      expect(service.getState().codex?.status).toBe(status)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['success', 'rate-limited'] as const)(
    'handles a raced %s result while resolving the selected home',
    async (outcome) => {
      await service.refresh()
      const oldRequest = deferred<ProviderRateLimits>()
      const fetchStarted = deferred<void>()
      vi.mocked(fetchCodexRateLimits).mockImplementationOnce(() => {
        fetchStarted.resolve()
        return oldRequest.promise
      })
      const inFlight = service.refreshCodexForTarget()
      await fetchStarted.promise
      await writeFile(join(home, 'auth.json'), '{"fixture":"new-login"}')
      const resolvedHome = deferred<{ kind: 'ready'; codexHomePath: string }>()
      let waitOnce = true
      service.setCodexHomePathResolver(() => {
        if (waitOnce) {
          waitOnce = false
          return resolvedHome.promise
        }
        return { kind: 'ready', codexHomePath: home }
      })
      const resume = service.refreshIfStale()
      const result =
        outcome === 'success'
          ? okProvider('codex', 17)
          : {
              ...errorProvider('codex', 'Rate limited'),
              usageMetadata: { retryAtMs: Date.now() + 60_000 }
            }
      oldRequest.resolve(result)
      await inFlight
      resolvedHome.resolve({ kind: 'ready', codexHomePath: home })
      await resume

      if (outcome === 'rate-limited') {
        expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
        expect(service.getState().codex).toEqual(result)
      } else {
        expect(fetchCodexRateLimits).toHaveBeenCalledTimes(3)
        expect(service.getState().codex?.session?.usedPercent).toBe(23)
      }
    }
  )

  it('recovers when the attached window gains focus after login', async () => {
    const window = new FakeRateLimitWindow()
    service.attach(asRateLimitWindow(window))
    await service.refresh()
    await writeFile(join(home, 'auth.json'), '{"fixture":"focus-login"}')
    const recovered = deferred<void>()
    service.onStateChange((state) => {
      if (state.codex?.status === 'ok') {
        recovered.resolve()
      }
    })
    window.emit('focus')
    await recovered.promise

    expect(service.getState().codex?.session?.usedPercent).toBe(23)
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
  })

  it('retains a login change deferred by Retry-After until the gate expires', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await writeFile(join(home, 'auth.json'), '{"fixture":"expired"}')
    await probeCodexAuthPresence(home)
    vi.mocked(fetchCodexRateLimits).mockImplementation(async () =>
      errorProvider('codex', 'Expired')
    )
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await service.refresh()
    }
    const oldRequest = deferred<ProviderRateLimits>()
    const fetchStarted = deferred<void>()
    vi.mocked(fetchCodexRateLimits).mockImplementationOnce(() => {
      fetchStarted.resolve()
      return oldRequest.promise
    })
    const inFlight = service.refreshIfStale()
    await fetchStarted.promise
    await writeFile(join(home, 'auth.json'), '{"fixture":"new-login"}')
    const resolvedHome = deferred<{ kind: 'ready'; codexHomePath: string }>()
    let waitOnce = true
    service.setCodexHomePathResolver(() => {
      if (waitOnce) {
        waitOnce = false
        return resolvedHome.promise
      }
      return { kind: 'ready', codexHomePath: home }
    })
    const resume = service.refreshIfStale()
    oldRequest.resolve({
      ...errorProvider('codex', 'Rate limited'),
      usageMetadata: { retryAtMs: now + 60_000 }
    })
    await inFlight
    resolvedHome.resolve({ kind: 'ready', codexHomePath: home })
    await resume
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(9)

    now += 60_001
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 23))
    await service.refreshIfStale()
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(10)
    expect(service.getState().codex?.session?.usedPercent).toBe(23)
  })

  it('does not restore the pre-login snapshot from an older full refresh', async () => {
    await service.refresh()
    const homeResolved = deferred<{ kind: 'ready'; codexHomePath: string }>()
    const homeEntered = deferred<void>()
    let waitOnce = true
    service.setCodexHomePathResolver(() => {
      if (waitOnce) {
        waitOnce = false
        homeEntered.resolve()
        return homeResolved.promise
      }
      return { kind: 'ready', codexHomePath: home }
    })
    const oldRefresh = service.refresh()
    await homeEntered.promise
    await writeFile(join(home, 'auth.json'), '{"fixture":"new-login"}')
    const recoveryStarted = deferred<void>()
    let recovering = false
    const resurrected: string[] = []
    service.onStateChange((state) => {
      if (state.codex?.status === 'fetching' && !state.codex.error) {
        recovering = true
        recoveryStarted.resolve()
      }
      if (recovering && state.codex?.error) {
        resurrected.push(state.codex.error)
      }
    })
    const resume = service.refreshIfStale()
    await recoveryStarted.promise
    homeResolved.resolve({ kind: 'ready', codexHomePath: home })
    await Promise.all([oldRefresh, resume])

    expect(resurrected).toEqual([])
    expect(service.getState().codex?.status).toBe('ok')
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
  })

  it('cancels a stale healthy subscription refresh when stopped during the resume check', async () => {
    await writeFile(join(home, 'auth.json'), '{"fixture":"signed-in"}')
    await service.refresh()
    const later = Date.now() + 6 * 60_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    const resume = service.refreshIfStale()
    service.stop()
    await resume

    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
    expect(service.getState().codex?.status).toBe('ok')
  })
})
