import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusIpcPayload
} from '../../shared/agent-status-types'
import { hookAuthority } from './agent-state-rules/agent-state-rules-engine'
import { parseAgentStateRuleFiles } from './agent-state-rules/agent-state-rules-catalog'
import { hookLeadTurnState, readTuiIdleHookTurn, type TuiIdleHookTurn } from './tui-idle-hook-lane'
import {
  evaluateTuiIdle,
  type TuiIdleEvaluationInput,
  type TuiIdleEvidenceRecord
} from './tui-idle-evidence'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const OTHER_PANE_KEY = 'tab-2:22222222-2222-4222-8222-222222222222'
const HANDLE = 'term_hook_lane'
const QUIESCENCE_MS = 3000
const DONE: TuiIdleHookTurn = { state: 'done', blockedReason: null }
const WORKING: TuiIdleHookTurn = { state: 'working', blockedReason: null }

function row(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  const now = Date.now()
  return {
    paneKey: PANE_KEY,
    connectionId: null,
    state: 'done',
    prompt: '',
    agentType: 'pi',
    receivedAt: now,
    stateStartedAt: now,
    ...overrides
  }
}

describe('hookLeadTurnState', () => {
  it('reads the main agent, so a subagent finishing or running does not decide the lead turn', () => {
    // A child still runs after the lead ended: the combined row works, the lead is done.
    expect(
      hookLeadTurnState({ state: 'working', mainAgent: { state: 'done', stateStartedAt: 1 } })
    ).toBe('done')
    // A child's Stop while the lead still works leaves the lead working.
    expect(
      hookLeadTurnState({ state: 'done', mainAgent: { state: 'working', stateStartedAt: 1 } })
    ).toBe('working')
  })

  it('reads a cancelled turn as ended', () => {
    expect(
      hookLeadTurnState({
        state: 'done',
        mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 1 }
      })
    ).toBe('done')
  })

  it("blocks on any agent's permission wait, a child's included", () => {
    expect(hookLeadTurnState({ state: 'waiting' })).toBe('permission')
    expect(hookLeadTurnState({ state: 'blocked' })).toBe('permission')
    expect(
      hookLeadTurnState({ state: 'waiting', mainAgent: { state: 'working', stateStartedAt: 1 } })
    ).toBe('permission')
  })

  it('falls back to the row state for agents that publish no main agent', () => {
    expect(hookLeadTurnState({ state: 'done' })).toBe('done')
    expect(hookLeadTurnState({ state: 'working' })).toBe('working')
  })

  it('leaves a session start to the startup rules', () => {
    expect(hookLeadTurnState({ state: 'done', sessionBoundary: true })).toBeNull()
  })
})

describe('readTuiIdleHookTurn', () => {
  const base = {
    agent: 'pi' as const,
    handles: [HANDLE],
    paneKeys: [PANE_KEY],
    resolveBlockedText: () => null
  }

  it('reads a fresh row joined on the pane key', () => {
    expect(readTuiIdleHookTurn({ ...base, hookRows: [row()] })).toEqual(DONE)
  })

  it('joins a row on the terminal handle when the pane key differs', () => {
    expect(
      readTuiIdleHookTurn({
        ...base,
        hookRows: [row({ paneKey: OTHER_PANE_KEY, terminalHandle: HANDLE, state: 'working' })]
      })
    ).toEqual(WORKING)
  })

  it('has no answer for a pane no row joins', () => {
    expect(
      readTuiIdleHookTurn({
        ...base,
        handles: [],
        paneKeys: [],
        hookRows: [row({ terminalHandle: HANDLE })]
      })
    ).toBeNull()
    expect(
      readTuiIdleHookTurn({ ...base, hookRows: [row({ paneKey: OTHER_PANE_KEY })] })
    ).toBeNull()
  })

  it('refuses stale, restored and identity-only rows', () => {
    const staleAt = Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1
    for (const stale of [
      row({ receivedAt: staleAt }),
      row({ evidenceObservedAt: staleAt }),
      row({ restoredUnconfirmed: true }),
      row({ providerSessionOnly: true })
    ]) {
      expect(readTuiIdleHookTurn({ ...base, hookRows: [stale] })).toBeNull()
    }
  })

  it("refuses a row another agent wrote, and one from the pane's previous process", () => {
    expect(readTuiIdleHookTurn({ ...base, hookRows: [row({ agentType: 'claude' })] })).toBeNull()
    const receivedAt = Date.now() - 1000
    expect(
      readTuiIdleHookTurn({
        ...base,
        hookRows: [row({ receivedAt })],
        respawnedAt: receivedAt + 1
      })
    ).toBeNull()
    expect(
      readTuiIdleHookTurn({
        ...base,
        hookRows: [row({ receivedAt })],
        respawnedAt: receivedAt
      })
    ).toEqual(DONE)
  })

  it('reads no done from before the latest input, whose turn may not have reported yet', () => {
    const receivedAt = Date.now() - 1000
    expect(
      readTuiIdleHookTurn({
        ...base,
        hookRows: [row({ receivedAt })],
        lastInputAt: receivedAt + 1
      })
    ).toBeNull()
    expect(
      readTuiIdleHookTurn({ ...base, hookRows: [row({ receivedAt })], lastInputAt: receivedAt })
    ).toEqual(DONE)
    // A working row keeps the pane busy whatever its age against the input.
    expect(
      readTuiIdleHookTurn({
        ...base,
        hookRows: [row({ receivedAt, state: 'working' })],
        lastInputAt: receivedAt + 1
      })
    ).toEqual(WORKING)
  })

  it('blocks on a wait the hook reports with no dialog text the arbiter knows (a question)', () => {
    const receivedAt = Date.now() - 1000
    for (const state of ['waiting', 'blocked'] as const) {
      expect(readTuiIdleHookTurn({ ...base, hookRows: [row({ receivedAt, state })] })).toEqual({
        state: 'permission',
        blockedReason: 'agent-interactive-prompt'
      })
    }
    // Input since the wait opened may have answered it before the next hook arrived.
    expect(
      readTuiIdleHookTurn({
        ...base,
        hookRows: [row({ receivedAt, state: 'waiting' })],
        lastInputAt: receivedAt + 1
      })
    ).toEqual({ state: 'permission', blockedReason: null })
  })

  it('takes the newest joined row', () => {
    const now = Date.now()
    expect(
      readTuiIdleHookTurn({
        ...base,
        hookRows: [
          row({ state: 'done', receivedAt: now }),
          row({ state: 'working', receivedAt: now - 10, terminalHandle: HANDLE })
        ]
      })
    ).toEqual(DONE)
  })

  it("hands the permission arbiter the lead turn as the pane's explicit status", () => {
    const resolveBlockedText = vi.fn(() => 'agent-approval-prompt' as const)
    const waiting = row({ state: 'waiting' })
    expect(readTuiIdleHookTurn({ ...base, resolveBlockedText, hookRows: [waiting] })).toEqual({
      state: 'permission',
      blockedReason: 'agent-approval-prompt'
    })
    expect(resolveBlockedText).toHaveBeenCalledWith('permission', waiting)
    const childRunning = row({ state: 'working', mainAgent: { state: 'done', stateStartedAt: 1 } })
    readTuiIdleHookTurn({ ...base, resolveBlockedText, hookRows: [childRunning] })
    expect(resolveBlockedText).toHaveBeenLastCalledWith('done', childRunning)
  })
})

describe('profile.hooks', () => {
  it('marks the agents whose hooks report every turn end as authoritative', () => {
    for (const agent of ['opencode', 'opencode2', 'pi', 'omp'] as const) {
      expect(hookAuthority(agent)).toBe('authoritative')
    }
    // Codex before its Interrupt hook posts nothing for an Esc, so only its done is trusted.
    expect(hookAuthority('codex')).toBe('turn-end')
    for (const agent of ['claude', 'cursor', 'gemini', 'grok', null] as const) {
      expect(hookAuthority(agent)).toBe('identity-only')
    }
  })

  it('rejects an authority outside the closed list', () => {
    expect(() =>
      parseAgentStateRuleFiles([
        { id: 'pi', engineVersion: 1, profile: { hooks: 'partial' }, anchors: [], rules: [] }
      ])
    ).toThrow(/hooks/)
  })
})

function record(overrides: Partial<TuiIdleEvidenceRecord> = {}): TuiIdleEvidenceRecord {
  return { lastAgentStatus: null, lastOutputAt: Date.now(), lastOscTitle: null, ...overrides }
}

function input(overrides: Partial<TuiIdleEvaluationInput> = {}): TuiIdleEvaluationInput {
  return {
    record: record(),
    readTailBlockedReason: () => null,
    readPositiveBodyEvidence: () => false,
    readQuietReadyBodyEvidence: () => false,
    readAgentRuleVerdict: () => null,
    readScreenInputVeto: () => null,
    titleObservedAtEpochMs: null,
    agent: 'pi',
    firstPartyStatus: null,
    quiescenceMs: QUIESCENCE_MS,
    ...overrides
  }
}

describe('evaluateTuiIdle hook lane', () => {
  it('settles at once on a done turn, with no title and a streaming pane (headless)', () => {
    expect(evaluateTuiIdle(input({ readHookTurn: () => DONE }))).toEqual({
      kind: 'ready-strong'
    })
  })

  it('holds a working turn over ready text and an idle title', () => {
    expect(
      evaluateTuiIdle(
        input({
          record: record({ lastAgentStatus: 'idle', lastOscTitle: 'Pi ready' }),
          readPositiveBodyEvidence: () => true,
          readHookTurn: () => WORKING
        })
      )
    ).toEqual({ kind: 'working' })
  })

  it('blocks with the arbiter reason, and leaves an unconfirmed wait to the screen read', () => {
    expect(
      evaluateTuiIdle(
        input({
          readHookTurn: () => ({ state: 'permission', blockedReason: 'agent-approval-prompt' })
        })
      )
    ).toEqual({ kind: 'blocked', reason: 'agent-approval-prompt' })
    expect(
      evaluateTuiIdle(
        input({
          readPositiveBodyEvidence: () => true,
          readHookTurn: () => ({ state: 'permission', blockedReason: null })
        })
      )
    ).toEqual({ kind: 'pending', quietForeground: 'closed' })
  })

  it('lets the arbiter, not the raw tail, judge blocked text once a fresh row exists', () => {
    // A denied prompt's dialog text lingers in the tail after the hook says the turn ended.
    expect(
      evaluateTuiIdle(
        input({ readTailBlockedReason: () => 'agent-interactive-prompt', readHookTurn: () => DONE })
      )
    ).toEqual({ kind: 'ready-strong' })
    expect(
      evaluateTuiIdle(
        input({
          readTailBlockedReason: () => 'agent-interactive-prompt',
          readHookTurn: () => ({ state: 'done', blockedReason: 'agent-trust-workspace' })
        })
      )
    ).toEqual({ kind: 'blocked', reason: 'agent-trust-workspace' })
    // With no fresh row, the raw tail still blocks.
    expect(
      evaluateTuiIdle(
        input({ readTailBlockedReason: () => 'agent-trust-workspace', readHookTurn: () => null })
      )
    ).toEqual({ kind: 'blocked', reason: 'agent-trust-workspace' })
  })

  it('falls back to the other lanes with no fresh row (startup, before the first prompt)', () => {
    expect(
      evaluateTuiIdle(input({ readPositiveBodyEvidence: () => true, readHookTurn: () => null }))
    ).toEqual({ kind: 'ready-strong' })
    expect(
      evaluateTuiIdle(input({ readPositiveBodyEvidence: () => false, readHookTurn: () => null }))
    ).toEqual({ kind: 'pending', quietForeground: 'closed' })
  })

  it('ignores an ordinary done hook for identity-only claude', () => {
    const readHookTurn = vi.fn(() => DONE)
    expect(evaluateTuiIdle(input({ agent: 'claude', readHookTurn }))).toEqual({
      kind: 'pending',
      quietForeground: 'closed'
    })
    expect(readHookTurn).toHaveBeenCalledOnce()
  })
})

describe('evaluateTuiIdle turn-end hook lane (codex)', () => {
  it('settles at once on a done turn, with no title and a streaming pane (headless)', () => {
    expect(evaluateTuiIdle(input({ agent: 'codex', readHookTurn: () => DONE }))).toEqual({
      kind: 'ready-strong'
    })
  })

  it('still blocks on a done turn whose arbiter confirms the blocked text', () => {
    expect(
      evaluateTuiIdle(
        input({
          agent: 'codex',
          readHookTurn: () => ({ state: 'done', blockedReason: 'agent-approval-prompt' })
        })
      )
    ).toEqual({ kind: 'blocked', reason: 'agent-approval-prompt' })
  })

  it('lets the rules settle over a working row an Esc left behind (Codex before Interrupt)', () => {
    expect(
      evaluateTuiIdle(
        input({
          agent: 'codex',
          readQuietReadyBodyEvidence: () => true,
          record: record({ lastOutputAt: Date.now() - QUIESCENCE_MS }),
          readHookTurn: () => WORKING
        })
      )
    ).toEqual({ kind: 'ready-strong' })
  })

  it('leaves a working or permission row to the rules, which hold a busy pane', () => {
    for (const turn of [
      WORKING,
      { state: 'permission', blockedReason: 'agent-approval-prompt' } as const
    ]) {
      expect(evaluateTuiIdle(input({ agent: 'codex', readHookTurn: () => turn }))).toEqual({
        kind: 'pending',
        quietForeground: 'closed'
      })
      expect(
        evaluateTuiIdle(
          input({
            agent: 'codex',
            readTailBlockedReason: () => 'agent-trust-workspace',
            readHookTurn: () => turn
          })
        )
      ).toEqual({ kind: 'blocked', reason: 'agent-trust-workspace' })
    }
  })
})
