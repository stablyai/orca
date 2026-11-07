import { describe, expect, it } from 'vitest'
import type { EnrichedAgentHookEventPayload } from '../server-types'
import {
  HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS as SILENCE,
  programStatusHookYieldEndsAt
} from './hook-precedence'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status/contracts/agent-status-types'

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
  it('keeps a turn the hooks settled from a later block unless the program worked since', () => {
    const hook = row({ state: 'done', agentType: 'antigravity' })
    const block = report({ state: 'waiting', agentType: 'antigravity' })
    expect(programStatusHookYieldEndsAt(hook, block)).toBe(Infinity)
    expect(programStatusHookYieldEndsAt(hook, block, NOW - 1)).toBe(Infinity)
    expect(programStatusHookYieldEndsAt(hook, block, NOW)).toBe(Infinity)
    expect(programStatusHookYieldEndsAt(hook, block, NOW + 1)).toBeUndefined()
    for (const state of ['working', 'blocked'] as const) {
      expect(programStatusHookYieldEndsAt(hook, report({ state, agentType: 'antigravity' }))).toBe(
        NOW + SILENCE
      )
    }
  })

  it("never lets a program's child roster reopen a turn the hooks settled", () => {
    const hook = row({ state: 'done', agentType: 'pi' })
    const heldOpen = report({
      state: 'working',
      agentType: 'pi',
      mainAgent: { state: 'done', outcome: 'success', stateStartedAt: NOW }
    })
    expect(programStatusHookYieldEndsAt(hook, heldOpen, NOW + 1)).toBe(Infinity)
  })

  it("never lets a program's done settle a turn the hooks hold open for children", () => {
    const heldOpen = row({
      state: 'working',
      agentType: 'antigravity',
      mainAgent: { state: 'done', outcome: 'success', stateStartedAt: NOW }
    })
    expect(
      programStatusHookYieldEndsAt(heldOpen, report({ state: 'done', agentType: 'antigravity' }))
    ).toBe(Infinity)
  })

  it('keeps a question the hooks raised only from a working report that began before it', () => {
    for (const state of ['waiting', 'blocked'] as const) {
      const hook = row({ state, agentType: 'pi' })
      const working = report({ state: 'working', agentType: 'pi' })
      expect(programStatusHookYieldEndsAt(hook, working, NOW - 1)).toBe(Infinity)
      expect(programStatusHookYieldEndsAt(hook, working, NOW)).toBe(Infinity)
      expect(programStatusHookYieldEndsAt(hook, working, NOW + 1)).toBe(NOW + SILENCE)
      expect(programStatusHookYieldEndsAt(hook, working)).toBe(NOW + SILENCE)
      expect(programStatusHookYieldEndsAt(hook, report({ state: 'done', agentType: 'pi' }))).toBe(
        NOW + SILENCE
      )
    }
  })
})
