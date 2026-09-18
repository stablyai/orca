import { describe, expect, it } from 'vitest'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  codexQuotaAvailability,
  isCodexQuotaFailedTurn,
  selectCodexWarmupModel
} from './codex-automation-policy'

function model(id: string, efforts: string[]): AgentSessionModelOption {
  return {
    id,
    label: id,
    isDefault: false,
    efforts: efforts.map((value) => ({ value, label: value }))
  }
}
const window = { usedPercent: 10, windowMinutes: 300, resetsAt: 200_000, resetDescription: null }
const usage: ProviderRateLimits = {
  provider: 'codex',
  status: 'ok',
  error: null,
  updatedAt: 100_000,
  session: window,
  weekly: window
}

describe('Codex account automation policy', () => {
  it('uses prices and the lowest advertised effort, independently of list order', () => {
    expect(
      selectCodexWarmupModel([
        model('gpt-5.6-sol', ['low']),
        model('gpt-5.4-mini', ['low', 'minimal', 'none']),
        model('gpt-5.6-luna', ['low'])
      ])
    ).toEqual({ model: 'gpt-5.4-mini', effort: 'none' })
  })
  it('never invents effort support or guesses a price for an unknown model', () => {
    expect(
      selectCodexWarmupModel([model('future-model', ['none']), model('gpt-5.4-nano', [])])
    ).toBeNull()
    expect(selectCodexWarmupModel([model('gpt-5.6-luna', ['high', 'low'])])).toEqual({
      model: 'gpt-5.6-luna',
      effort: 'low'
    })
  })
  it('does not price a custom variant as its cheaper parent model', () => {
    expect(selectCodexWarmupModel([model('gpt-5.4-nano-expensive', ['none'])])).toBeNull()
  })
  it('requires fresh known windows', () => {
    expect(codexQuotaAvailability(usage, 100_000)).toBe('usable')
    for (const value of [
      null,
      { ...usage, session: null },
      { ...usage, weekly: null },
      { ...usage, updatedAt: 1 }
    ]) {
      expect(codexQuotaAvailability(value, 100_000)).toBe('unknown')
    }
  })
  it('distinguishes quota exhaustion from network and auth failures', () => {
    expect(
      codexQuotaAvailability({ ...usage, weekly: { ...window, usedPercent: 100 } }, 100_000)
    ).toBe('exhausted')
    expect(codexQuotaAvailability({ ...usage, status: 'error', error: 'network' }, 100_000)).toBe(
      'unknown'
    )
    for (const codexErrorInfo of [
      'unauthorized',
      'rateLimitExceeded',
      'serverOverloaded',
      { httpConnectionFailed: { httpStatusCode: 429 } }
    ]) {
      expect(
        isCodexQuotaFailedTurn({ turn: { status: 'failed', error: { codexErrorInfo } } })
      ).toBe(false)
    }
    expect(
      isCodexQuotaFailedTurn({
        turn: { status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } }
      })
    ).toBe(true)
    expect(
      isCodexQuotaFailedTurn({
        turn: { status: 'inProgress', error: { codexErrorInfo: 'usageLimitExceeded' } }
      })
    ).toBe(false)
  })
  it('does not treat an elapsed reset as observed capacity', () => {
    expect(
      codexQuotaAvailability(
        { ...usage, session: { ...window, usedPercent: 100, resetsAt: 99_999 } },
        100_000
      )
    ).toBe('unknown')
  })
})
