import { describe, expect, it } from 'vitest'
import { finalReplayFrame } from './agent-transcript-replay-test-harness'
import { evaluateAgentStateRules } from '../../agent-state-rules/agent-state-rules-engine'

// prime-agent 0.9.8 on macOS, OpenRouter, isolated HOME; 0.9.5 recorded for PR #22154 (see
// each .meta.json); STA-8741.
const at120x40 = (name: string, what: string) => ({ name, what, cols: 120, rows: 40 })
const at120x35 = (name: string, what: string) => ({ name, what, cols: 120, rows: 35 })
const READY = [
  at120x40('prime-agent-0-9-8-ready', 'settled startup'),
  at120x40('prime-agent-0-9-8-ready-after-question', 'trace question answered Not now'),
  { name: 'prime-agent-0-9-8-ready-80x24', what: 'settled startup', cols: 80, rows: 24 },
  at120x40('prime-agent-0-9-8-turn-ended', 'a turn has ended'),
  at120x40('prime-agent-0-9-8-tool-turn', 'a turn with a tool call has ended'),
  at120x35('prime-agent-0-9-5-ready', '0.9.5 settled startup'),
  at120x35('prime-agent-0-9-5-turn', '0.9.5 turn ended')
]
const NOT_READY = [
  at120x40('prime-agent-0-9-8-trace-question', 'first-launch trace-sharing question'),
  at120x40('prime-agent-0-9-8-slash-menu', 'slash menu open'),
  at120x40('prime-agent-0-9-8-busy-streaming', 'answer streaming'),
  at120x40('prime-agent-0-9-8-draft', 'unsent text in the composer')
]

describe('Prime Agent readiness from captured bytes', () => {
  it.each(READY)('$name ($what) reads ready', async ({ name, cols, rows }) => {
    const { ruledScreenLines } = await finalReplayFrame(name, cols, rows)
    expect(
      evaluateAgentStateRules('prime-agent', { readScreenLines: () => ruledScreenLines })?.state
    ).toBe('idle')
  })

  it.each(NOT_READY)('$name ($what) does not read ready', async ({ name, cols, rows }) => {
    const { ruledScreenLines } = await finalReplayFrame(name, cols, rows)
    expect(
      evaluateAgentStateRules('prime-agent', { readScreenLines: () => ruledScreenLines })?.state
    ).not.toBe('idle')
  })
})
