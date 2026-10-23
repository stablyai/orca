import { describe, expect, it } from 'vitest'
import type { EnrichedAgentHookEventPayload } from '../server-types'
import {
  HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS as SILENCE,
  programStatusHookYieldEndsAt
} from './hook-precedence'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'

const NOW = 1_000_000

function row(
  payload: Omit<ParsedAgentStatusPayload, 'prompt'>,
  overrides: Partial<EnrichedAgentHookEventPayload> = {},
  origin: 'hook' | 'osc' = 'hook'
): EnrichedAgentHookEventPayload {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rule reads only origin, providerSessionOnly, receivedAt and payload.
  return {
    paneKey: 'tab:leaf',
    receivedAt: NOW,
    observation: { origin },
    payload: { prompt: 'fix it', ...payload },
    ...overrides
  } as EnrichedAgentHookEventPayload
}

const report = (payload: Omit<ParsedAgentStatusPayload, 'prompt'>): ParsedAgentStatusPayload => ({
  prompt: '',
  ...payload
})

describe('programStatusHookYieldEndsAt', () => {
  it('applies when no hook row speaks for the pane', () => {
    expect(programStatusHookYieldEndsAt(undefined, report({ state: 'working' }))).toBeUndefined()
    expect(
      programStatusHookYieldEndsAt(row({ state: 'working' }, {}, 'osc'), report({ state: 'done' }))
    ).toBeUndefined()
    expect(
      programStatusHookYieldEndsAt(
        row({ state: 'done' }, { providerSessionOnly: true }),
        report({ state: 'working' })
      )
    ).toBeUndefined()
  })

  it('yields to a live hook row of the same agent until its hooks fall silent', () => {
    const hook = row({ state: 'working', agentType: 'claude' })
    expect(programStatusHookYieldEndsAt(hook, report({ state: 'done', agentType: 'claude' }))).toBe(
      NOW + SILENCE
    )
  })

  it('keeps yielding through a long silent tool call that the program agrees with', () => {
    const hook = row({ state: 'working', agentType: 'claude' })
    expect(
      programStatusHookYieldEndsAt(hook, report({ state: 'working', agentType: 'claude' }))
    ).toBe(Infinity)
  })

  it('keeps a turn the hooks settled from a later block unless the program worked since', () => {
    const hook = row({ state: 'done', agentType: 'antigravity' })
    const block = report({ state: 'waiting', agentType: 'antigravity' })
    expect(programStatusHookYieldEndsAt(hook, block)).toBe(Infinity)
    expect(programStatusHookYieldEndsAt(hook, block, NOW - 1)).toBe(Infinity)
    expect(programStatusHookYieldEndsAt(hook, block, NOW + 1)).toBeUndefined()
    for (const state of ['working', 'blocked'] as const) {
      expect(programStatusHookYieldEndsAt(hook, report({ state, agentType: 'antigravity' }))).toBe(
        NOW + SILENCE
      )
    }
  })

  it('yields to a mid-turn hook row under another app id, not to a finished one', () => {
    expect(
      programStatusHookYieldEndsAt(
        row({ state: 'working', agentType: 'openclaude' }),
        report({ state: 'done', agentType: 'claude' })
      )
    ).toBe(NOW + SILENCE)
    expect(
      programStatusHookYieldEndsAt(
        row({ state: 'done', agentType: 'claude' }),
        report({ state: 'working', agentType: 'terraform' })
      )
    ).toBeUndefined()
  })
})
