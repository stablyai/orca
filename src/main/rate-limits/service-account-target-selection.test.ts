import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { consumeCodexRateLimitResetCredit, fetchCodexRateLimits } from './codex-fetcher'
import {
  deferred,
  okProvider,
  resetRateLimitProviderMocks
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

describe('RateLimitService', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
  })

  it('settles without applying a result when the managed home becomes unavailable mid-fetch', async () => {
    const service = new RateLimitService()
    const resolver = vi
      .fn()
      .mockReturnValueOnce({ kind: 'ready', codexHomePath: '/tmp/codex-home' })
      .mockReturnValue({ kind: 'skip' })
    service.setCodexHomePathResolver(resolver)
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))

    await service.refreshForCodexAccountChange(null, { runtime: 'host' })

    expect(resolver).toHaveBeenCalledTimes(2)
    expect(fetchCodexRateLimits).toHaveBeenCalledOnce()
    expect(service.getState().codex).toBeNull()
  })

  it('returns a refreshed scoped state without overwriting a target selected during reset', async () => {
    const service = new RateLimitService()
    const idempotencyKey = '22222222-2222-4222-8222-222222222222'
    const consume = vi.mocked(consumeCodexRateLimitResetCredit)
    let resolveConsume: ((outcome: 'reset') => void) | undefined
    consume.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConsume = resolve
        })
    )
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 0, Date.now()))

    service.setCodexHomePathResolver(() => ({ kind: 'ready', codexHomePath: '/tmp/new-selection' }))
    const pending = service.consumeCodexRateLimitResetCredit({
      idempotencyKey,
      target: { runtime: 'host', wslDistro: null },
      codexHomePath: '/tmp/approved-selection'
    })
    await vi.waitFor(() => expect(consume).toHaveBeenCalledOnce())
    service.setCodexFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    resolveConsume?.('reset')

    await expect(pending).resolves.toMatchObject({
      outcome: 'reset',
      state: {
        codexTarget: { runtime: 'host', wslDistro: null },
        codex: { session: { usedPercent: 0 } }
      }
    })
    expect(consume).toHaveBeenCalledWith({
      codexHomePath: '/tmp/approved-selection',
      idempotencyKey
    })
    expect(fetchCodexRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({
        codexHomePath: '/tmp/approved-selection',
        signal: expect.any(AbortSignal)
      })
    )
    expect(service.getState().codexTarget).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(service.getState().codex).toBeNull()
  })

  it('keeps the reset result scoped when the active target changes during its refresh', async () => {
    const service = new RateLimitService()
    const idempotencyKey = '33333333-3333-4333-8333-333333333333'
    const hostRefresh = deferred<ProviderRateLimits>()
    service.setCodexHomePathResolver((target) => ({
      kind: 'ready',
      codexHomePath: target?.runtime === 'wsl' ? '/tmp/wsl-selection' : '/tmp/approved-selection'
    }))
    vi.mocked(consumeCodexRateLimitResetCredit).mockResolvedValueOnce('reset')
    vi.mocked(fetchCodexRateLimits)
      .mockReturnValueOnce(hostRefresh.promise)
      .mockResolvedValueOnce(okProvider('codex', 73, Date.now()))

    const pendingReset = service.consumeCodexRateLimitResetCredit({
      idempotencyKey,
      target: { runtime: 'host', wslDistro: null },
      codexHomePath: '/tmp/approved-selection'
    })
    await vi.waitFor(() => expect(fetchCodexRateLimits).toHaveBeenCalledOnce())

    await service.refreshCodexForTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    hostRefresh.resolve(okProvider('codex', 0, Date.now()))

    await expect(pendingReset).resolves.toMatchObject({
      outcome: 'reset',
      state: {
        codexTarget: { runtime: 'host', wslDistro: null },
        codex: { session: { usedPercent: 0 } }
      }
    })
    expect(service.getState()).toMatchObject({
      codexTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      codex: { session: { usedPercent: 73 } }
    })
  })

  it('does not let an older full refresh overwrite the post-reset Codex state', async () => {
    const service = new RateLimitService()
    const slowClaude = deferred<ProviderRateLimits>()
    service.setCodexHomePathResolver(() => ({
      kind: 'ready',
      codexHomePath: '/tmp/approved-selection'
    }))
    vi.mocked(fetchClaudeRateLimits).mockReturnValueOnce(slowClaude.promise)
    vi.mocked(fetchCodexRateLimits)
      .mockResolvedValueOnce(okProvider('codex', 100, Date.now()))
      .mockResolvedValueOnce(okProvider('codex', 0, Date.now()))
    vi.mocked(consumeCodexRateLimitResetCredit).mockResolvedValueOnce('reset')

    const olderRefresh = service.refresh()
    await vi.waitFor(() => expect(fetchCodexRateLimits).toHaveBeenCalledOnce())

    await service.consumeCodexRateLimitResetCredit({
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
      target: { runtime: 'host', wslDistro: null },
      codexHomePath: '/tmp/approved-selection'
    })
    expect(service.getState().codex?.session?.usedPercent).toBe(0)

    slowClaude.resolve(okProvider('claude', 20, Date.now()))
    await olderRefresh

    expect(service.getState().codex?.session?.usedPercent).toBe(0)
  })

  it('does not fetch host Codex usage when WSL home resolution fails', async () => {
    const service = new RateLimitService()
    const resolver = vi.fn(() => ({ kind: 'ready' as const, codexHomePath: null }))
    service.setCodexHomePathResolver(resolver)
    service.setCodexFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))

    await service.refresh()

    expect(resolver).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(fetchCodexRateLimits).not.toHaveBeenCalled()
    expect(service.getState().codex).toMatchObject({
      provider: 'codex',
      status: 'error',
      error: 'WSL Codex home unavailable for Ubuntu'
    })
  })

  it('does not cache host Codex usage under an outgoing WSL account', async () => {
    const service = new RateLimitService()
    const wslCodexHome =
      '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
    const hostCodexHome = 'C:\\Users\\jin\\.orca\\codex-accounts\\host\\home'
    service.setCodexHomePathResolver((target) => ({
      kind: 'ready',
      codexHomePath: target?.runtime === 'wsl' ? wslCodexHome : hostCodexHome
    }))

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits)
      .mockResolvedValueOnce(okProvider('codex', 20, Date.now()))
      .mockResolvedValueOnce(okProvider('codex', 40, Date.now()))

    await service.refresh()
    await service.refreshForCodexAccountChange('wsl-account-1', {
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(service.getState().inactiveCodexAccounts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ accountId: 'wsl-account-1' })])
    )
  })

  it('does not cache host Claude usage under an outgoing WSL account', async () => {
    const service = new RateLimitService()
    service.setInactiveClaudeAccountsResolver(() => [{ id: 'wsl-account-1' }])
    service.setClaudeAuthPreparationResolver(async (target) => ({
      configDir:
        target?.runtime === 'wsl'
          ? '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.claude'
          : 'C:\\Users\\jin\\.claude',
      runtime: target?.runtime ?? 'host',
      wslDistro: target?.wslDistro ?? null,
      wslLinuxConfigDir: target?.runtime === 'wsl' ? '/home/jin/.claude' : null,
      envPatch: {},
      provenance: target?.runtime === 'wsl' ? 'managed:wsl-account-1:wsl:Ubuntu' : 'system'
    }))

    vi.mocked(fetchClaudeRateLimits)
      .mockResolvedValueOnce(okProvider('claude', 20, Date.now()))
      .mockResolvedValueOnce(okProvider('claude', 40, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))

    await service.refresh()
    await service.refreshForClaudeAccountChange('wsl-account-1', {
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(fetchClaudeRateLimits).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowPtyFallback: true, allowUsagePanelSupplement: true })
    )

    expect(service.getState().inactiveClaudeAccounts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ accountId: 'wsl-account-1' })])
    )
  })

  // Regression: the Codex home resolver is async, and a reset never waits on isFetching.
  it('does not apply a stale full-refresh cycle codex result over a newer reset', async () => {
    const service = new RateLimitService()
    const staleHome = deferred<{ kind: 'ready'; codexHomePath: string | null }>()
    const resolver = vi
      .fn()
      .mockReturnValueOnce(staleHome.promise)
      .mockResolvedValue({ kind: 'ready', codexHomePath: '/tmp/approved-selection' })
    service.setCodexHomePathResolver(resolver)
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits)
      .mockResolvedValueOnce(okProvider('codex', 0, Date.now()))
      .mockResolvedValueOnce(okProvider('codex', 100, Date.now()))
    vi.mocked(consumeCodexRateLimitResetCredit).mockResolvedValueOnce('reset')

    const staleRefresh = service.refresh()
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1))

    await expect(
      service.consumeCodexRateLimitResetCredit({
        idempotencyKey: '55555555-5555-4555-8555-555555555555',
        target: { runtime: 'host', wslDistro: null },
        codexHomePath: '/tmp/approved-selection'
      })
    ).resolves.toMatchObject({ outcome: 'reset' })

    staleHome.resolve({ kind: 'ready', codexHomePath: '/tmp/approved-selection' })
    await staleRefresh

    expect(service.getState().codex?.session?.usedPercent).not.toBe(100)
  })
})
