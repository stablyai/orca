import { describe, expect, it } from 'vitest'
import { resolveWikiGenerationAgent } from './wiki-agent-selection'
import type { TuiAgent } from '../../shared/types'

// Why: disabledTuiAgents is a mutable TuiAgent[] on GlobalSettings, so `as const`
// (which the brief used) would freeze it to a readonly [] and fail to compile.
const base = {
  defaultTuiAgent: null,
  disabledTuiAgents: [] as TuiAgent[],
  sourceControlAi: undefined
}

describe('resolveWikiGenerationAgent', () => {
  it('prefers the sourceControlAi agent when set', () => {
    expect(
      resolveWikiGenerationAgent({
        ...base,
        sourceControlAi: { agentId: 'codex' } as never
      })
    ).toEqual({ ok: true, agent: 'codex' })
  })
  it('falls back to defaultTuiAgent', () => {
    expect(resolveWikiGenerationAgent({ ...base, defaultTuiAgent: 'claude' })).toEqual({
      ok: true,
      agent: 'claude'
    })
  })
  it('errors when no agent is configured', () => {
    expect(resolveWikiGenerationAgent(base)).toEqual({
      ok: false,
      error: expect.stringContaining('agent')
    })
  })
  it('errors when the resolved agent is disabled', () => {
    expect(
      resolveWikiGenerationAgent({
        ...base,
        defaultTuiAgent: 'claude',
        disabledTuiAgents: ['claude']
      })
    ).toMatchObject({ ok: false })
  })
})
