import { describe, expect, it } from 'vitest'
import { viewClaudeSessionStatus } from './mobile-claude-session-status-view'

const status = (
  usedTokens: number | null,
  windowTokens: number | null,
  compactions = 0,
  model: string | null = 'claude-opus-5-5'
) => ({ model, effort: null, usedTokens, windowTokens, compactions })

describe('viewClaudeSessionStatus', () => {
  it('shows percent and tokens against the window', () => {
    expect(viewClaudeSessionStatus(status(180000, 1000000))?.context).toEqual({
      percent: 18,
      used: '180k',
      window: '1M',
      tone: 'ok'
    })
  })

  it.each([
    [299999, 1000000, 'ok'],
    [300000, 1000000, 'warn'],
    [340000, 1000000, 'warn'],
    [794999, 1000000, 'warn'],
    [800000, 1000000, 'crit'],
    [830000, 1000000, 'crit'],
    [158000, 200000, 'ok'],
    [160000, 200000, 'crit']
  ])('colours %i of %i tokens as %s', (used, window, tone) => {
    expect(viewClaudeSessionStatus(status(used, window))?.context?.tone).toBe(tone)
  })

  it('shows tokens without a percent when the window is unknown', () => {
    expect(viewClaudeSessionStatus(status(340000, null))?.context).toEqual({
      percent: null,
      used: '340k',
      window: null,
      tone: 'warn'
    })
  })

  it('has no context readout right after a compaction', () => {
    expect(viewClaudeSessionStatus(status(null, 1000000, 3))).toEqual({
      context: null,
      compactions: 3,
      compactionTone: 'neutral'
    })
  })

  it.each([
    [0, 'neutral'],
    [3, 'neutral'],
    [4, 'warn'],
    [5, 'warn'],
    [6, 'crit'],
    [9, 'crit']
  ])('colours %i compactions as %s', (compactions, tone) => {
    expect(viewClaudeSessionStatus(status(1, 10, compactions))?.compactionTone).toBe(tone)
  })

  it('is absent when the session has reported nothing yet', () => {
    expect(viewClaudeSessionStatus(status(null, null, 0, null))).toBeNull()
  })
})
