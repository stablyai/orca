import { describe, expect, it } from 'vitest'
import type { EnrichedAgentHookEventPayload } from '../server-types'
import {
  HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS as SILENCE,
  programStatusYieldsToHookRow
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

describe('programStatusYieldsToHookRow', () => {
  it('applies when no hook row speaks for the pane', () => {
    expect(programStatusYieldsToHookRow(undefined, report({ state: 'working' }), NOW)).toBe(false)
    expect(
      programStatusYieldsToHookRow(
        row({ state: 'working' }, {}, 'osc'),
        report({ state: 'done' }),
        NOW
      )
    ).toBe(false)
    expect(
      programStatusYieldsToHookRow(
        row({ state: 'done' }, { providerSessionOnly: true }),
        report({ state: 'working' }),
        NOW
      )
    ).toBe(false)
  })

  it('yields to a live hook row of the same agent', () => {
    const hook = row({ state: 'working', agentType: 'claude' })
    expect(
      programStatusYieldsToHookRow(hook, report({ state: 'done', agentType: 'claude' }), NOW)
    ).toBe(true)
  })

  it('keeps yielding through a long silent tool call that the program agrees with', () => {
    const hook = row({ state: 'working', agentType: 'claude' })
    const later = NOW + 10 * SILENCE
    expect(
      programStatusYieldsToHookRow(hook, report({ state: 'working', agentType: 'claude' }), later)
    ).toBe(true)
  })

  it('takes the pane once silent hooks disagree with the program', () => {
    const hook = row({ state: 'working', agentType: 'claude' })
    const disagree = report({ state: 'done', agentType: 'claude' })
    expect(programStatusYieldsToHookRow(hook, disagree, NOW + SILENCE - 1)).toBe(true)
    expect(programStatusYieldsToHookRow(hook, disagree, NOW + SILENCE)).toBe(false)
  })

  it('yields to a mid-turn hook row under another app id, not to a finished one', () => {
    expect(
      programStatusYieldsToHookRow(
        row({ state: 'working', agentType: 'openclaude' }),
        report({ state: 'done', agentType: 'claude' }),
        NOW
      )
    ).toBe(true)
    expect(
      programStatusYieldsToHookRow(
        row({ state: 'done', agentType: 'claude' }),
        report({ state: 'working', agentType: 'terraform' }),
        NOW
      )
    ).toBe(false)
  })
})
