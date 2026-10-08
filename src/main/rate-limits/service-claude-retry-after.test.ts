import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClaudeOAuthCredentials from './claude-oauth-credentials'
import { RateLimitService } from './service'
import { deferred, resetRateLimitProviderMocks } from './rate-limit-service-test-harness'

/** 실제 인증이나 네트워크 없이 실행하는 시험 상태다. */
const fixture = vi.hoisted(() => ({ root: '', token: 'fixture-token', fetch: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})
vi.mock('electron', () => ({ net: { fetch: fixture.fetch }, session: { defaultSession: {} } }))
vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: vi.fn(async () => {})
}))
vi.mock('../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => fixture.root
}))
vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () => ({
    accountHome: (id: string) => join(fixture.root, id),
    userConfigDir: () => join(fixture.root, 'system')
  })
}))
vi.mock('./claude-oauth-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeOAuthCredentials>()),
  readClaudeOAuthCredentials: vi.fn(async () => ({
    token: fixture.token,
    hasRefreshableCredentials: false,
    source: 'credentials-file'
  }))
}))
vi.mock('./codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn(async () => ({ provider: 'codex', status: 'unavailable' }))
}))
vi.mock('./gemini-usage-fetcher', () => ({ fetchGeminiRateLimits: vi.fn() }))
vi.mock('./kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('./opencode-go-usage-source-selection', () => ({ fetchOpenCodeGoUsage: vi.fn() }))
vi.mock('./zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))
vi.mock('./antigravity-usage-fetcher', () => ({ fetchAntigravityRateLimits: vi.fn() }))
vi.mock('./minimax/minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('./grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('./cursor-fetcher', () => ({ fetchCursorRateLimits: vi.fn() }))
vi.mock('./cursor-auth', () => ({ readCursorAuthSession: vi.fn() }))
vi.mock('./grok-auth', () => ({ readGrokAuthSession: vi.fn(() => ({ status: 'missing' })) }))
vi.mock('../minimax/minimax-cookie-store', () => ({ hasMiniMaxSessionCookie: vi.fn(() => false) }))
vi.mock('../minimax/minimax-api-key-store', () => ({ hasMiniMaxApiKey: () => false }))
vi.mock('../zcode/zcode-plan-api-key-store', () => ({ hasZcodePlanApiKey: () => false }))

/** 모의 응답으로 서버가 지정한 계정별 대기를 검증한다. */
describe('Claude usage Retry-After across request paths', () => {
  let selected: string
  let service: RateLimitService

  /**
   * 선택된 계정과 같은 프로필 경로를 활성·비활성 조회에 제공한다.
   * @param next 설정할 서비스
   * @returns 설정된 서비스
   */
  function configure(next: RateLimitService): RateLimitService {
    next.setClaudeAuthPreparationResolver(async () => ({
      configDir: join(fixture.root, selected),
      runtime: 'host',
      envPatch: { CLAUDE_CONFIG_DIR: join(fixture.root, selected) },
      stripAuthEnv: true,
      provenance: `profile:${selected}`
    }))
    next.setInactiveClaudeAccountsResolver(() =>
      ['a', 'b'].filter((id) => id !== selected).map((id) => ({ id }))
    )
    return next
  }

  /**
   * 다음 사용량 요청에 429와 선택한 Retry-After를 반환한다.
   * @param retryAfter 서버 대기 헤더
   */
  function limit(retryAfter: string | null = '3600'): void {
    fixture.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 429,
        headers: retryAfter === null ? {} : { 'retry-after': retryAfter }
      })
    )
  }

  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fsPromises.readFile).mockClear()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'))
    fixture.root = mkdtempSync(join(tmpdir(), 'orca-usage-wait-'))
    fixture.token = 'fixture-token'
    fixture.fetch.mockReset().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            five_hour: { utilization: 23 },
            seven_day: { utilization: 41 },
            fable_weekly: { utilization: 17 },
            extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 2000 }
          }),
          { status: 200 }
        )
    )
    selected = 'a'
    service = configure(new RateLimitService())
  })

  afterEach(() => {
    service.stop()
    vi.useRealTimers()
    rmSync(fixture.root, { recursive: true, force: true })
  })

  it('inactive-on-open respects the account wait after its 60-second debounce expires', async () => {
    await service.fetchInactiveClaudeAccountsOnOpen()
    const original = service.getState().inactiveClaudeAccounts[0]?.rateLimits
    vi.setSystemTime(Date.now() + 61_000)
    limit()
    await service.fetchInactiveClaudeAccountsOnOpen()
    vi.setSystemTime(Date.now() + 61_000)
    await service.fetchInactiveClaudeAccountsOnOpen()
    expect(fixture.fetch).toHaveBeenCalledTimes(2)
    expect(service.getState().inactiveClaudeAccounts[0]?.rateLimits).toMatchObject({
      session: original?.session,
      updatedAt: original?.updatedAt
    })
  })

  it('forced manual refresh cannot bypass the server wait and retains the last usage', async () => {
    await service.refresh()
    const original = service.getState().claude
    limit()
    await service.refresh()
    const blocked = service.getState().claude
    await service.refresh()
    expect(fixture.fetch).toHaveBeenCalledTimes(2)
    expect(service.getState().claude).toEqual(blocked)
    expect(blocked).toMatchObject({ session: original?.session, updatedAt: original?.updatedAt })
  })

  it('account switching reuses the incoming account wait and value, without blocking its sibling', async () => {
    await service.refresh()
    const original = service.getState().claude
    limit()
    await service.refresh()
    selected = 'b'
    await service.refreshForClaudeAccountChange('a')
    expect(fixture.fetch).toHaveBeenCalledTimes(3)
    selected = 'a'
    await service.refreshForClaudeAccountChange('b')
    expect(fixture.fetch).toHaveBeenCalledTimes(3)
    expect(service.getState().claude).toMatchObject({
      session: original?.session,
      updatedAt: original?.updatedAt
    })
  })

  it('requests resume at the exact expiry of the server wait', async () => {
    limit()
    await service.refresh()
    vi.setSystemTime(Date.now() + 3_600_000 - 1)
    await service.refresh()
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 1)
    await service.refresh()
    expect(fixture.fetch).toHaveBeenCalledTimes(2)
    expect(service.getState().claude?.status).toBe('ok')
  })

  it.each([null, 'invalid', '0'])(
    'uses the normal 15-minute wait for Retry-After %s',
    async (header) => {
      limit(header)
      await service.refresh()
      expect(service.getState().claude?.usageMetadata?.retryAtMs).toBe(Date.now() + 900_000)
      vi.setSystemTime(Date.now() + 899_999)
      await service.refresh()
      expect(fixture.fetch).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.now() + 1)
      await service.refresh()
      expect(fixture.fetch).toHaveBeenCalledTimes(2)
    }
  )

  it('switching to a limited inactive account cannot issue another request', async () => {
    limit()
    await service.fetchInactiveClaudeAccountsOnOpen()
    selected = 'b'
    await service.refreshForClaudeAccountChange('a')
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
    expect(service.getState().claude).toMatchObject({
      status: 'error',
      session: null,
      weekly: null,
      usageMetadata: { retryAtMs: Date.now() + 3_600_000 }
    })
    selected = 'a'
    await service.refreshForClaudeAccountChange('b')
    expect(fixture.fetch).toHaveBeenCalledTimes(2)
  })

  it('forced target refresh and live usage cannot erase a server wait', async () => {
    limit()
    await service.refresh()
    service.ingestLiveClaudeRateLimits({
      configDir: join(fixture.root, selected),
      fiveHour: { utilization: 67 },
      sevenDay: null
    })
    expect(service.getState().claude?.status).toBe('ok')
    await service.refreshClaudeForTarget()
    await service.refresh()
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
    expect(service.getState().claude?.session?.usedPercent).toBe(67)
  })

  it('shares an in-flight inactive request when the same account becomes active', async () => {
    const response = deferred<Response>()
    fixture.fetch.mockReturnValueOnce(response.promise)
    const inactive = service.fetchInactiveClaudeAccountsOnOpen()
    await vi.waitFor(() => expect(fixture.fetch).toHaveBeenCalledTimes(1))
    selected = 'b'
    const active = service.refreshForClaudeAccountChange('a')
    response.resolve(new Response(null, { status: 429, headers: { 'retry-after': '3600' } }))
    await Promise.all([inactive, active])
    await service.refresh()
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
    expect(service.getState().claude?.usageMetadata?.retryAtMs).toBe(Date.now() + 3_600_000)
  })

  it('retries a transient cache read failure on the next refresh', async () => {
    const read = vi
      .mocked(fsPromises.readFile)
      .mockRejectedValueOnce(Object.assign(new Error('cache busy'), { code: 'EBUSY' }))
    await service.refresh()
    expect(read).toHaveBeenCalledTimes(1)
    expect(fixture.fetch).not.toHaveBeenCalled()
    await service.refresh()
    expect(read).toHaveBeenCalledTimes(2)
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
    expect(service.getState().claude?.status).toBe('ok')
  })

  it('does not overwrite a corrupt cache or issue requests with an unknown wait', async () => {
    const file = join(fixture.root, 'orca-claude-usage-cache.json')
    writeFileSync(file, '{')
    await service.refresh()
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(service.getState().claude?.status).toBe('error')
    expect(readFileSync(file, 'utf8')).toBe('{')
  })

  it('retains the wait and all quota values after module restart and token replacement', async () => {
    await service.refresh()
    const original = service.getState().claude
    limit()
    await service.refresh()
    service.stop()
    fixture.token = 'replacement-fixture-token'
    vi.resetModules()
    const { RateLimitService: RestartedService } = await import('./service')
    service = configure(new RestartedService())
    await service.refresh()
    expect(fixture.fetch).toHaveBeenCalledTimes(2)
    expect(service.getState().claude).toMatchObject({
      session: original?.session,
      weekly: original?.weekly,
      fableWeekly: original?.fableWeekly,
      extraUsage: original?.extraUsage,
      updatedAt: original?.updatedAt
    })
    const persisted = readFileSync(join(fixture.root, 'orca-claude-usage-cache.json'), 'utf8')
    expect(persisted).not.toContain('fixture-token')
    expect(persisted).not.toContain(fixture.root)
  })
})
