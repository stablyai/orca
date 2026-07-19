import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import { computeStatusPillAgentRows, computeStatusPillSummary } from './status-pill-summary'

const NOW = 1_000_000

function makeEntry(overrides: Partial<AgentStatusIpcPayload>): AgentStatusIpcPayload {
  return {
    state: 'working',
    prompt: '',
    updatedAt: NOW,
    receivedAt: NOW,
    stateStartedAt: NOW,
    paneKey: 'tab1:leaf1',
    connectionId: null,
    ...overrides
  } as AgentStatusIpcPayload
}

describe('computeStatusPillSummary', () => {
  it('returns an empty summary when no entries are passed', () => {
    const summary = computeStatusPillSummary([], NOW)
    expect(summary.working).toBe(0)
    expect(summary.hasAnyActivity).toBe(false)
    expect(summary.activityLabel).toBe('')
  })

  it('counts working / blocked / waiting / recentDone separately', () => {
    const entries = [
      makeEntry({ state: 'working', paneKey: 'a' }),
      makeEntry({ state: 'working', paneKey: 'b' }),
      makeEntry({ state: 'blocked', paneKey: 'c' }),
      makeEntry({ state: 'waiting', paneKey: 'd' }),
      makeEntry({ state: 'done', paneKey: 'e' })
    ]
    const summary = computeStatusPillSummary(entries, NOW)
    expect(summary.working).toBe(2)
    expect(summary.blocked).toBe(1)
    expect(summary.waiting).toBe(1)
    expect(summary.recentDone).toBe(1)
    expect(summary.hasAnyActivity).toBe(true)
  })

  it('drops stale done entries past the 30-min window', () => {
    const stale = NOW - 31 * 60 * 1000
    const entries = [
      makeEntry({ state: 'done', paneKey: 'old', receivedAt: stale, stateStartedAt: stale }),
      makeEntry({ state: 'done', paneKey: 'fresh' })
    ]
    const summary = computeStatusPillSummary(entries, NOW)
    expect(summary.recentDone).toBe(1)
  })

  it('skips providerSessionOnly entries (resume identity only)', () => {
    const entries = [
      makeEntry({ state: 'working', paneKey: 'a' }),
      makeEntry({
        state: 'working',
        paneKey: 'b',
        providerSessionOnly: true
      } as AgentStatusIpcPayload)
    ]
    const summary = computeStatusPillSummary(entries, NOW)
    expect(summary.working).toBe(1)
  })

  it('prefers working over blocked, blocked over waiting, waiting over done for the label', () => {
    const entries = [
      makeEntry({ state: 'done', paneKey: 'a', prompt: 'done-prompt', agentType: 'codex' }),
      makeEntry({ state: 'waiting', paneKey: 'b', prompt: 'waiting-prompt', agentType: 'gemini' }),
      makeEntry({ state: 'blocked', paneKey: 'c', prompt: 'blocked-prompt', agentType: 'claude' }),
      makeEntry({ state: 'working', paneKey: 'd', prompt: 'working-prompt', agentType: 'claude' })
    ]
    const summary = computeStatusPillSummary(entries, NOW)
    expect(summary.activityPaneKey).toBe('d')
    expect(summary.activityLabel).toContain('working-prompt')
    expect(summary.activityLabel).toContain('Claude')
  })

  it('exposes the active paneKey and tabId for click-to-focus', () => {
    const entries = [
      makeEntry({ state: 'working', paneKey: 'tab2:leaf3', tabId: 'tab2', agentType: 'claude' })
    ]
    const summary = computeStatusPillSummary(entries, NOW)
    expect(summary.activePaneKey).toBe('tab2:leaf3')
    expect(summary.activeTabId).toBe('tab2')
  })

  it('formats the activity label with agent + prompt + tool when all present', () => {
    const entries = [
      makeEntry({
        state: 'working',
        paneKey: 'p',
        agentType: 'claude',
        prompt: 'fix the auth bug',
        toolName: 'Edit'
      })
    ]
    const summary = computeStatusPillSummary(entries, NOW)
    expect(summary.activityLabel).toBe('Claude — fix the auth bug · Edit')
  })

  it('capitalizes well-known agent types and leaves unknown ones untouched', () => {
    const wellKnown = computeStatusPillSummary(
      [makeEntry({ state: 'working', paneKey: 'p1', agentType: 'codex', prompt: 'fix bug' })],
      NOW
    )
    expect(wellKnown.activityLabel).toMatch(/^Codex — /)
    const unknown = computeStatusPillSummary(
      [
        makeEntry({
          state: 'working',
          paneKey: 'p2',
          agentType: 'myCustomAgent',
          prompt: 'fix bug'
        })
      ],
      NOW
    )
    expect(unknown.activityLabel).toMatch(/^myCustomAgent — /)
  })

  it('returns empty when every entry is stale', () => {
    const stale = NOW - 60 * 60 * 1000
    const entries = [
      makeEntry({ state: 'working', paneKey: 'a', receivedAt: stale, stateStartedAt: stale })
    ]
    const summary = computeStatusPillSummary(entries, NOW)
    expect(summary.hasAnyActivity).toBe(false)
    expect(summary.working).toBe(0)
  })
})

describe('computeStatusPillAgentRows', () => {
  it('returns an empty list for no entries', () => {
    expect(computeStatusPillAgentRows([], NOW)).toEqual([])
  })

  it('skips providerSessionOnly entries', () => {
    const rows = computeStatusPillAgentRows(
      [
        makeEntry({ state: 'working', paneKey: 'a', agentType: 'claude', prompt: 'p1' }),
        makeEntry({
          state: 'working',
          paneKey: 'b',
          agentType: 'codex',
          providerSessionOnly: true
        } as AgentStatusIpcPayload)
      ],
      NOW
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.paneKey).toBe('a')
  })

  it('sorts rows by priority: working > blocked > waiting > done', () => {
    const rows = computeStatusPillAgentRows(
      [
        makeEntry({ state: 'done', paneKey: 'a', agentType: 'codex' }),
        makeEntry({ state: 'waiting', paneKey: 'b', agentType: 'gemini' }),
        makeEntry({ state: 'working', paneKey: 'c', agentType: 'claude' })
      ],
      NOW
    )
    expect(rows.map((r) => r.state)).toEqual(['working', 'waiting', 'done'])
  })

  it('preserves agentType, state, prompt, toolName on each row', () => {
    const rows = computeStatusPillAgentRows(
      [
        makeEntry({
          state: 'working',
          paneKey: 'a',
          agentType: 'claude',
          prompt: 'fix bug',
          toolName: 'Edit'
        })
      ],
      NOW
    )
    expect(rows[0]).toMatchObject({
      agentType: 'claude',
      state: 'working',
      prompt: 'fix bug',
      toolName: 'Edit'
    })
  })
})
