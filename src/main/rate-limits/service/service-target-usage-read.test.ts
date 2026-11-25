import { expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { ClaudeRuntimeAuthPreparation } from '../../claude-accounts/runtime-auth/runtime-auth-types'
import { RateLimitService } from './rate-limit-service'

const { claudeFetch, codexFetch } = vi.hoisted(() => ({
  claudeFetch: vi.fn(),
  codexFetch: vi.fn()
}))

vi.mock('../providers/claude/claude-active-usage-fetch', () => ({
  fetchActiveClaudeRateLimits: claudeFetch
}))
vi.mock('../providers/codex/codex-fetcher', () => ({
  fetchCodexRateLimits: codexFetch,
  consumeCodexRateLimitResetCredit: vi.fn()
}))
vi.mock('../providers/grok/grok-auth', () => ({
  readGrokAuthSession: () => ({ status: 'missing' })
}))
vi.mock('../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: async () => false
}))
vi.mock('../../minimax/minimax-api-key-store', () => ({ hasMiniMaxApiKey: async () => false }))
vi.mock('../../zcode/zcode-plan-api-key-store', () => ({ hasZcodePlanApiKey: async () => false }))

function ok(provider: 'claude' | 'codex', usedPercent: number): ProviderRateLimits {
  return {
    provider,
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

const preparation: ClaudeRuntimeAuthPreparation = {
  configDir: '/home/u/.claude',
  envPatch: {},
  provenance: 'wsl:Ubuntu'
}

it('reads a WSL distro usage without switching the desktop fetch target or publishing state', async () => {
  claudeFetch.mockResolvedValue(ok('claude', 42))
  codexFetch.mockResolvedValue(ok('codex', 24))
  const claudeTargets: unknown[] = []
  const codexTargets: unknown[] = []
  const service = new RateLimitService()
  service.setClaudeAuthPreparationResolver(async (target) => {
    claudeTargets.push(target)
    return preparation
  })
  service.setCodexHomePathResolver(async (target) => {
    codexTargets.push(target)
    return { kind: 'ready', codexHomePath: '/home/u/.codex' }
  })

  const read = await service.readUsageForRuntimeTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  expect(read.claude?.session?.usedPercent).toBe(42)
  expect(read.codex?.session?.usedPercent).toBe(24)
  expect(read.claudeTarget).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  expect(read.codexTarget).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  expect(claudeTargets).toEqual([{ runtime: 'wsl', wslDistro: 'Ubuntu' }])
  expect(codexTargets).toEqual([{ runtime: 'wsl', wslDistro: 'Ubuntu' }])

  // The desktop's own fetch target and published state stay untouched by the read.
  const state = await service.getState()
  expect(state.claude).toBeNull()
  expect(state.codex).toBeNull()
  expect(state.claudeTarget).toEqual({ runtime: 'host', wslDistro: null })
  expect(state.codexTarget).toEqual({ runtime: 'host', wslDistro: null })
})
