import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import {
  STATUS_PILL_ATTENTION_COOLDOWN_MS,
  computeStatusPillAttentionTransitions
} from './status-pill-attention'

function makeEntry(overrides: Partial<AgentStatusIpcPayload>): AgentStatusIpcPayload {
  return {
    paneKey: 'tab-1:leaf-1',
    agentType: 'claude',
    state: 'waiting',
    prompt: '',
    toolName: 'AskUserQuestion',
    interactivePrompt: '{"questions":[{"header":"h","options":[]}]}',
    receivedAt: 1000,
    worktreeId: 'repo::/path',
    providerSessionOnly: false,
    ...overrides
  } as AgentStatusIpcPayload
}

describe('computeStatusPillAttentionTransitions', () => {
  it('flags a pane that newly enters a waiting state with a prompt', () => {
    const next = [makeEntry({ paneKey: 'a', state: 'waiting' })]
    const out = computeStatusPillAttentionTransitions([], next, 5_000, new Map())
    expect(out).toHaveLength(1)
    expect(out[0]?.paneKey).toBe('a')
    expect(out[0]?.urgency).toBe('waiting')
  })

  it('does not re-flag a pane that was already attentive in the previous snapshot', () => {
    const prev = [makeEntry({ paneKey: 'a', state: 'waiting' })]
    const next = [makeEntry({ paneKey: 'a', state: 'waiting' })]
    const out = computeStatusPillAttentionTransitions(prev, next, 5_000, new Map())
    expect(out).toHaveLength(0)
  })

  it('respects the per-pane cooldown for a leave -> re-enter flicker', () => {
    const cooldowns = new Map([['a', 5_000]])
    const next = [makeEntry({ paneKey: 'a', state: 'waiting' })]
    // Why: now - lastAlert (1s) < cooldown (30s) -> suppressed.
    const within = computeStatusPillAttentionTransitions(
      [],
      next,
      6_000,
      cooldowns,
      STATUS_PILL_ATTENTION_COOLDOWN_MS
    )
    expect(within).toHaveLength(0)
    // Why: past the cooldown it fires again.
    const past = computeStatusPillAttentionTransitions(
      [],
      next,
      5_000 + STATUS_PILL_ATTENTION_COOLDOWN_MS + 1,
      cooldowns
    )
    expect(past).toHaveLength(1)
  })

  it('ignores entries without an interactive prompt', () => {
    const next = [makeEntry({ paneKey: 'a', state: 'waiting', interactivePrompt: '' })]
    expect(computeStatusPillAttentionTransitions([], next, 1, new Map())).toHaveLength(0)
  })

  it('ignores working / done states even with a prompt', () => {
    const next = [makeEntry({ paneKey: 'a', state: 'working' })]
    expect(computeStatusPillAttentionTransitions([], next, 1, new Map())).toHaveLength(0)
  })

  it('ranks a blocked permission prompt ahead of a waiting question', () => {
    const next = [
      makeEntry({ paneKey: 'waiting-pane', state: 'waiting' }),
      makeEntry({ paneKey: 'blocked-pane', state: 'blocked' })
    ]
    const out = computeStatusPillAttentionTransitions([], next, 1, new Map())
    expect(out[0]?.paneKey).toBe('blocked-pane')
    expect(out[1]?.paneKey).toBe('waiting-pane')
  })

  it('skips providerSessionOnly entries', () => {
    const next = [makeEntry({ paneKey: 'a', providerSessionOnly: true })]
    expect(computeStatusPillAttentionTransitions([], next, 1, new Map())).toHaveLength(0)
  })
})
