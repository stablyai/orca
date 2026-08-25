import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { consumeCodexRateLimitResetCredit, fetchCodexRateLimits } from './codex-fetcher'
import {
  deferred,
  errorProvider,
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

vi.mock('./opencode-go-usage-fetcher', () => ({
  fetchOpenCodeGoRateLimits: vi.fn()
}))

vi.mock('./minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
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

  it('passes the selected WSL Codex home into active account rate-limit fetches', async () => {
    const service = new RateLimitService()
    const wslCodexHome =
      '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
    const hostCodexHome = 'C:\\Users\\jin\\.orca\\codex-accounts\\host\\home'
    const resolver = vi.fn((target) => ({
      kind: 'ready' as const,
      codexHomePath: target?.runtime === 'wsl' ? wslCodexHome : hostCodexHome
    }))
    service.setCodexHomePathResolver(resolver)

    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))

    await service.refreshForCodexAccountChange(null, { runtime: 'wsl', wslDistro: 'Ubuntu' })

    expect(resolver).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(fetchCodexRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({ codexHomePath: wslCodexHome })
    )
  })

  it.each([
    [
      'account-change refresh',
      (service: RateLimitService) => service.refreshForCodexAccountChange(null, { runtime: 'host' })
    ],
    [
      'target refresh',
      (service: RateLimitService) => service.refreshCodexForTarget({ runtime: 'host' })
    ]
  ])('settles %s when managed-home resolution skips before the fetch', async (_label, refresh) => {
    const service = new RateLimitService()
    service.setCodexHomePathResolver(() => ({ kind: 'skip' }))

    await refresh(service)

    expect(fetchCodexRateLimits).not.toHaveBeenCalled()
    expect(service.getState().codex).toBeNull()
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

  it('settles the Codex slot when its home becomes unavailable during a full refresh', async () => {
    const service = new RateLimitService()
    service.setCodexHomePathResolver(
      vi
        .fn()
        .mockReturnValueOnce({ kind: 'ready', codexHomePath: '/tmp/codex-home' })
        .mockReturnValue({ kind: 'skip' })
    )
    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))

    await service.refresh()

    expect(fetchCodexRateLimits).toHaveBeenCalledOnce()
    expect(service.getState().codex).toBeNull()
  })

  it('reuses a caller-provided idempotency key when consuming a Codex reset credit', async () => {
    const service = new RateLimitService()
    const idempotencyKey = '11111111-1111-4111-8111-111111111111'
    service.setCodexHomePathResolver(() => ({ kind: 'ready', codexHomePath: '/tmp/codex-home' }))
    vi.mocked(consumeCodexRateLimitResetCredit).mockResolvedValueOnce('reset')
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 0, Date.now()))

    await expect(
      service.consumeCodexRateLimitResetCredit({
        idempotencyKey,
        target: { runtime: 'host', wslDistro: null },
        codexHomePath: '/tmp/codex-home'
      })
    ).resolves.toMatchObject({ outcome: 'reset' })
    expect(consumeCodexRateLimitResetCredit).toHaveBeenCalledWith({
      codexHomePath: '/tmp/codex-home',
      idempotencyKey
    })
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

  it('uses the initialized WSL target for active Codex rate-limit fetches', async () => {
    const service = new RateLimitService()
    const wslCodexHome =
      '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
    const hostCodexHome = 'C:\\Users\\jin\\.orca\\codex-accounts\\host\\home'
    const resolver = vi.fn((target) => ({
      kind: 'ready' as const,
      codexHomePath: target?.runtime === 'wsl' ? wslCodexHome : hostCodexHome
    }))
    service.setCodexHomePathResolver(resolver)
    service.setCodexFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))

    await service.refresh()

    expect(resolver).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(fetchCodexRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({ codexHomePath: wslCodexHome })
    )
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

  it('uses the initialized WSL target for active Claude rate-limit fetches', async () => {
    const service = new RateLimitService()
    const resolver = vi.fn(async (target) => ({
      configDir:
        target?.runtime === 'wsl'
          ? '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.claude'
          : 'C:\\Users\\jin\\.claude',
      runtime: target?.runtime ?? 'host',
      wslDistro: target?.wslDistro ?? null,
      wslLinuxConfigDir: target?.runtime === 'wsl' ? '/home/jin/.claude' : null,
      envPatch: target?.runtime === 'wsl' ? { CLAUDE_CONFIG_DIR: '/home/jin/.claude' } : {},
      stripAuthEnv: target?.runtime === 'wsl',
      provenance: target?.runtime === 'wsl' ? 'managed:wsl-account:wsl:Ubuntu' : 'system'
    }))
    service.setClaudeAuthPreparationResolver(resolver)
    service.setClaudeFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))

    await service.refresh()

    expect(resolver).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(fetchClaudeRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({
        authPreparation: expect.objectContaining({
          runtime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxConfigDir: '/home/jin/.claude',
          stripAuthEnv: true
        }),
        allowPtyFallback: true,
        allowUsagePanelSupplement: true,
        signal: expect.any(AbortSignal)
      })
    )
    expect(service.getState().claudeTarget).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('does not use Claude PTY fallback for system-default usage refreshes', async () => {
    const service = new RateLimitService()
    service.setClaudeAuthPreparationResolver(async () => ({
      configDir: '/tmp/.claude',
      runtime: 'host',
      wslDistro: null,
      wslLinuxConfigDir: null,
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }))

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))

    await service.refresh()

    expect(fetchClaudeRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({
        authPreparation: expect.objectContaining({ provenance: 'system' }),
        allowPtyFallback: false,
        allowUsagePanelSupplement: true,
        signal: expect.any(AbortSignal)
      })
    )
  })

  it('does not use Claude PTY fallback when Claude auth preparation is unavailable', async () => {
    const service = new RateLimitService()

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))

    await service.refresh()

    expect(fetchClaudeRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({
        authPreparation: undefined,
        allowPtyFallback: false,
        allowUsagePanelSupplement: true,
        signal: expect.any(AbortSignal)
      })
    )
  })

  it('does not use Claude PTY fallback for WSL system-default usage refreshes', async () => {
    const service = new RateLimitService()
    service.setClaudeFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    service.setClaudeAuthPreparationResolver(async () => ({
      configDir: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.claude',
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      wslLinuxConfigDir: '/home/jin/.claude',
      envPatch: {},
      stripAuthEnv: true,
      provenance: 'wsl:Ubuntu:system'
    }))

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))

    await service.refresh()

    expect(fetchClaudeRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({
        authPreparation: expect.objectContaining({ provenance: 'wsl:Ubuntu:system' }),
        allowPtyFallback: false,
        allowUsagePanelSupplement: true,
        signal: expect.any(AbortSignal)
      })
    )
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

  it('caches an outgoing weekly-only Codex account so the switcher keeps its inline bars', async () => {
    const service = new RateLimitService()
    service.setInactiveCodexAccountsResolver(() => [
      inactiveCodexAccount('account-weekly', '/tmp/account-weekly/home')
    ])

    const weeklyOnly: ProviderRateLimits = {
      provider: 'codex',
      session: null,
      weekly: { usedPercent: 76, windowMinutes: 10080, resetsAt: null, resetDescription: null },
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits)
      .mockResolvedValueOnce(weeklyOnly)
      .mockResolvedValueOnce(okProvider('codex', 40, Date.now()))

    await service.refresh()
    await service.refreshForCodexAccountChange('account-weekly')

    expect(service.getState().inactiveCodexAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: 'account-weekly',
          rateLimits: expect.objectContaining({
            session: null,
            weekly: expect.objectContaining({ usedPercent: 76 })
          })
        })
      ])
    )
  })

  it('does not cache an outgoing Codex account that has no usage windows', async () => {
    const service = new RateLimitService()
    service.setInactiveCodexAccountsResolver(() => [
      inactiveCodexAccount('account-empty', '/tmp/account-empty/home')
    ])

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits)
      .mockResolvedValueOnce(errorProvider('codex', 'codex not signed in'))
      .mockResolvedValueOnce(okProvider('codex', 40, Date.now()))

    await service.refresh()
    await service.refreshForCodexAccountChange('account-empty')

    expect(service.getState().inactiveCodexAccounts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ accountId: 'account-empty' })])
    )
  })

  it('does not cache host Claude usage under an outgoing WSL account', async () => {
    const service = new RateLimitService()
    service.setInactiveClaudeAccountsResolver(() => [
      { id: 'wsl-account-1', managedAuthPath: '/tmp/account-1/auth' }
    ])
    service.setClaudeAuthPreparationResolver(async (target) => ({
      configDir:
        target?.runtime === 'wsl'
          ? '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.claude'
          : 'C:\\Users\\jin\\.claude',
      runtime: target?.runtime ?? 'host',
      wslDistro: target?.wslDistro ?? null,
      wslLinuxConfigDir: target?.runtime === 'wsl' ? '/home/jin/.claude' : null,
      envPatch: {},
      stripAuthEnv: target?.runtime === 'wsl',
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
})

function inactiveCodexAccount(id: string, managedHomePath: string) {
  return {
    id,
    resolveHome: () => ({ kind: 'ready' as const, managedHomePath })
  }
}
