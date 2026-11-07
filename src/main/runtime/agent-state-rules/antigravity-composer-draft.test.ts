import { describe, expect, it } from 'vitest'
import { finalReplayFrame } from '../agent-transcript-replay-test-harness'
import { evaluateAgentStateRules } from './agent-state-rules-engine'

const verdict = (lines: readonly string[]) =>
  evaluateAgentStateRules('antigravity', { readScreenLines: () => lines })?.state

describe('an Antigravity composer holding a mode-shaped draft', () => {
  it('holds when agy 1.2.7 shows the plan placeholder typed as unsent text', async () => {
    const { ruledScreenLines } = await finalReplayFrame(
      'antigravity-plan-hint-as-draft-127',
      120,
      40
    )
    expect(verdict(ruledScreenLines)).toBe('hold')
  })

  it('holds for a draft that only reads like an edit mode', () => {
    const rule = '─'.repeat(40)
    expect(verdict([rule, '> dark mode: fix the toggle', rule, 'Gemini 3.7 Flash · low'])).toBe(
      'hold'
    )
  })
})
