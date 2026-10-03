import { afterEach, describe, expect, it, vi } from 'vitest'
import { USAGE_HANDLERS } from './usage'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from '../args'
import { USAGE_COMMAND_SPECS } from '../specs/usage'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import type {
  ProviderRateLimits,
  RateLimitState,
  RateLimitWindow
} from '../../shared/rate-limit-types'

function window(usedPercent: number, resetDescription: string | null): RateLimitWindow {
  return { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription }
}

function provider(overrides: Partial<ProviderRateLimits>): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'ok',
    ...overrides
  }
}

function stateWith(overrides: Partial<RateLimitState>): RateLimitState {
  const target = { runtime: 'host' as const, wslDistro: null }
  return {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: null,
    minimaxCookieConfigured: false,
    minimaxApiKeyConfigured: false,
    grokAuthConfigured: false,
    claudeTarget: target,
    codexTarget: target,
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: [],
    ...overrides
  }
}

function contextFor(
  rateLimits: RateLimitState,
  flags: Map<string, string | boolean>,
  json = false
): { ctx: HandlerContext; callMock: ReturnType<typeof vi.fn> } {
  const callMock = vi.fn().mockResolvedValue({
    id: '1',
    ok: true,
    result: { rateLimits },
    _meta: { runtimeId: 'r' }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the usage handler only calls client.call; the rest of RuntimeClient is unused.
  const client = { call: callMock } as unknown as RuntimeClient
  return { ctx: { client, json, flags, cwd: '/' }, callMock }
}

describe('usage handler', () => {
  afterEach(() => vi.restoreAllMocks())

  it('defaults to cached numbers (refreshUsage false) and reports every provider', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ctx, callMock } = contextFor(
      stateWith({
        claude: provider({ session: window(42, '2:30 PM'), weekly: window(18, 'Thu') })
      }),
      new Map()
    )
    await USAGE_HANDLERS.usage(ctx)
    expect(callMock).toHaveBeenCalledWith('accounts.list', { refreshUsage: false })
    const output = log.mock.calls[0][0]
    expect(output).toContain(
      'claude: 5h 42% used (58% left), resets 2:30 PM  |  7d 18% used (82% left), resets Thu'
    )
    expect(output).toContain('codex: not configured')
  })

  it('forces a live fetch with --refresh', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ctx, callMock } = contextFor(stateWith({}), new Map([['refresh', true]]))
    await USAGE_HANDLERS.usage(ctx)
    expect(callMock).toHaveBeenCalledWith('accounts.list', { refreshUsage: true })
  })

  it('filters to a single provider and shows plan and reset credits', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ctx } = contextFor(
      stateWith({
        claude: provider({ session: window(10, null) }),
        codex: provider({
          provider: 'codex',
          session: window(71, '4:15 PM'),
          planType: 'plus',
          rateLimitResetCredits: { availableCount: 2 }
        })
      }),
      new Map([['provider', 'codex']])
    )
    await USAGE_HANDLERS.usage(ctx)
    const output = log.mock.calls[0][0]
    expect(output).toBe(
      'codex: 5h 71% used (29% left), resets 4:15 PM  [plan: plus, reset credits: 2]'
    )
    expect(output).not.toContain('claude')
  })

  it('renders the Claude Fable weekly window instead of "no window data"', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ctx } = contextFor(
      stateWith({ claude: provider({ fableWeekly: window(63, 'Sun') }) }),
      new Map([['provider', 'claude']])
    )
    await USAGE_HANDLERS.usage(ctx)
    const output = log.mock.calls[0][0]
    expect(output).toContain('Fable 7d 63% used (37% left), resets Sun')
    expect(output).not.toContain('no window data')
  })

  it('renders Gemini per-model buckets by name', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ctx } = contextFor(
      stateWith({
        gemini: provider({
          provider: 'gemini',
          buckets: [
            { ...window(20, '5:00 PM'), name: 'gemini-2.5-pro' },
            { ...window(5, '5:00 PM'), name: 'gemini-2.5-flash' }
          ]
        })
      }),
      new Map([['provider', 'gemini']])
    )
    await USAGE_HANDLERS.usage(ctx)
    const output = log.mock.calls[0][0]
    expect(output).toContain('gemini-2.5-pro 20% used (80% left), resets 5:00 PM')
    expect(output).toContain('gemini-2.5-flash 5% used (95% left), resets 5:00 PM')
    expect(output).not.toContain('no window data')
  })

  it('surfaces an error status instead of a window', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ctx } = contextFor(
      stateWith({
        gemini: provider({ provider: 'gemini', status: 'error', error: 'usage endpoint 429' })
      }),
      new Map([['provider', 'gemini']])
    )
    await USAGE_HANDLERS.usage(ctx)
    expect(log.mock.calls[0][0]).toBe('gemini: usage endpoint 429 (status: error)')
  })

  it('rejects an unknown provider', async () => {
    const { ctx, callMock } = contextFor(stateWith({}), new Map([['provider', 'bogus']]))
    await expect(USAGE_HANDLERS.usage(ctx)).rejects.toThrow(/Unknown provider "bogus"/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('emits machine-readable JSON scoped to the selected provider', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ctx } = contextFor(
      stateWith({ claude: provider({ session: window(42, '2:30 PM') }) }),
      new Map([['provider', 'claude']]),
      true
    )
    await USAGE_HANDLERS.usage(ctx)
    const parsed = JSON.parse(log.mock.calls[0][0])
    expect(parsed.result.providers).toHaveLength(1)
    expect(parsed.result.providers[0].provider).toBe('claude')
    expect(parsed.result.providers[0].usage.session.usedPercent).toBe(42)
  })
})

// Why: the positional `provider` is normalized into a --provider flag, so it must
// pass flag validation. A live run caught this; this locks the full arg path.
describe('usage arg wiring', () => {
  function resolve(argv: string[]): ReturnType<typeof parseArgs> {
    const parsed = normalizeCommandPositionals(USAGE_COMMAND_SPECS, parseArgs(argv, [['usage']]))
    validateCommandAndFlags(USAGE_COMMAND_SPECS, parsed)
    return parsed
  }

  it('accepts a positional provider and canonicalizes it onto the usage command', () => {
    const parsed = resolve(['usage', 'claude'])
    expect(parsed.commandPath).toEqual(['usage'])
    expect(parsed.flags.get('provider')).toBe('claude')
  })

  it('accepts --refresh alongside a positional provider', () => {
    const parsed = resolve(['usage', 'codex', '--refresh'])
    expect(parsed.flags.get('provider')).toBe('codex')
    expect(parsed.flags.get('refresh')).toBe(true)
  })

  it('rejects an unknown flag', () => {
    expect(() => resolve(['usage', '--bogus'])).toThrow(/Unknown flag --bogus/)
  })
})
