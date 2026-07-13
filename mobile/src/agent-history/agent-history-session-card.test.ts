import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import {
  buildMobileAgentHistoryResumeActionState,
  buildMobileAgentHistoryCard,
  isSessionInActiveWorktree
} from './agent-history-session-card'
import { buildMobileAgentHistorySections } from './agent-history-sections'
import { MOBILE_AI_VAULT_CAPABILITY } from './agent-history-capability'
import { shouldShowMobileCurrentWorktreeBadge } from './agent-history-current-worktree-badge'

const NOW = Date.parse('2026-06-29T00:00:00.000Z')

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'claude:1',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'session-1',
    title: 'Implement vault filters',
    cwd: '/Users/ada/repo/app',
    branch: 'feature/vault',
    model: 'claude-sonnet-4-5',
    filePath: '/Users/ada/.claude/projects/session-1.jsonl',
    codexHome: null,
    createdAt: '2026-06-28T23:00:00.000Z',
    updatedAt: '2026-06-28T23:55:00.000Z',
    modifiedAt: '2026-06-28T23:55:00.000Z',
    messageCount: 4,
    totalTokens: 1200,
    previewMessages: [
      { role: 'user', text: 'add the scope tabs', timestamp: null },
      { role: 'assistant', text: 'done — tabs added', timestamp: null }
    ],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    ...overrides
  }
}

describe('buildMobileAgentHistoryCard', () => {
  it('maps the card view-model with time-ago, label, and last message', () => {
    const card = buildMobileAgentHistoryCard(session(), '/Users/ada/repo/app', NOW)
    expect(card.agentLabel).toBe('Claude')
    expect(card.timeAgo).toBe('5m')
    expect(card.lastMessage).toBe('done — tabs added')
    expect(card.messageCount).toBe(4)
    expect(card.isCurrentWorktree).toBe(true)
  })

  it('omits the current-worktree badge when cwd is outside the active worktree', () => {
    const card = buildMobileAgentHistoryCard(session(), '/Users/ada/other', NOW)
    expect(card.isCurrentWorktree).toBe(false)
  })

  it('falls back to a title for empty session titles', () => {
    const card = buildMobileAgentHistoryCard(session({ title: '' }), null, NOW)
    expect(card.title).toBe('Untitled session')
    expect(card.isCurrentWorktree).toBe(false)
  })
})

describe('buildMobileAgentHistoryResumeActionState', () => {
  it('disables all resume buttons while one session is launching', () => {
    const state = buildMobileAgentHistoryResumeActionState(
      [session({ id: 'claude:1' }), session({ id: 'codex:2', agent: 'codex' })],
      'codex:2'
    )
    expect(state.get('claude:1')).toEqual({ disabled: true, loading: false })
    expect(state.get('codex:2')).toEqual({ disabled: true, loading: true })
  })

  it('keeps resume buttons enabled when no launch is in flight', () => {
    const state = buildMobileAgentHistoryResumeActionState([session({ id: 'claude:1' })], null)
    expect(state.get('claude:1')).toEqual({ disabled: false, loading: false })
  })
})

describe('isSessionInActiveWorktree', () => {
  it('matches a nested cwd inside the worktree path', () => {
    expect(
      isSessionInActiveWorktree({ cwd: '/Users/ada/repo/app/src' }, '/Users/ada/repo/app')
    ).toBe(true)
  })

  it('is false without a cwd or active path', () => {
    expect(isSessionInActiveWorktree({ cwd: null }, '/Users/ada/repo/app')).toBe(false)
    expect(isSessionInActiveWorktree({ cwd: '/Users/ada/repo/app' }, null)).toBe(false)
  })
})

describe('buildMobileAgentHistorySections', () => {
  it('hides empty sessions by default and groups remaining by folder', () => {
    const sections = buildMobileAgentHistorySections(
      [
        session(),
        // Truly empty: no turns, no preview turns, no recoverable signals —
        // preview turns alone now count as resumable content and stay visible.
        session({ id: 'claude:empty', messageCount: 0, previewMessages: [] })
      ],
      {
        query: '',
        scope: 'all',
        scopeFilterPaths: [],
        activeWorktreePath: '/Users/ada/repo/app',
        now: NOW
      }
    )
    const allCards = sections.flatMap((s) => s.data)
    expect(allCards.map((card) => card.id)).toEqual(['claude:1'])
  })

  it('applies the search query across sections', () => {
    const sections = buildMobileAgentHistorySections(
      [session(), session({ id: 'claude:2', title: 'Repair terminal tabs' })],
      { query: 'repair', scope: 'all', scopeFilterPaths: [], activeWorktreePath: null, now: NOW }
    )
    expect(sections.flatMap((s) => s.data).map((card) => card.id)).toEqual(['claude:2'])
  })

  // Why: the host union widens, so the screen must narrow scoped tabs by cwd
  // path-prefix on the client — otherwise Workspace/Project show the same set as All.
  it('narrows Workspace scope to sessions whose cwd is inside the active worktree path', () => {
    const sessions = [
      session({ id: 'claude:in', cwd: '/Users/ada/repo/app/src' }),
      session({ id: 'claude:out', cwd: '/Users/ada/other-repo' })
    ]
    const sections = buildMobileAgentHistorySections(sessions, {
      query: '',
      scope: 'workspace',
      scopeFilterPaths: ['/Users/ada/repo/app'],
      activeWorktreePath: '/Users/ada/repo/app',
      now: NOW
    })
    expect(sections.flatMap((s) => s.data).map((card) => card.id)).toEqual(['claude:in'])
  })

  it('narrows Project scope to the active worktree plus same-repo sibling paths', () => {
    const sessions = [
      session({ id: 'claude:active', cwd: '/Users/ada/repo/app' }),
      session({ id: 'claude:sibling', cwd: '/Users/ada/repo/app-feature/lib' }),
      session({ id: 'claude:foreign', cwd: '/Users/ada/unrelated' })
    ]
    const sections = buildMobileAgentHistorySections(sessions, {
      query: '',
      scope: 'project',
      scopeFilterPaths: ['/Users/ada/repo/app', '/Users/ada/repo/app-feature'],
      activeWorktreePath: '/Users/ada/repo/app',
      now: NOW
    })
    expect(
      sections
        .flatMap((s) => s.data)
        .map((card) => card.id)
        .sort()
    ).toEqual(['claude:active', 'claude:sibling'])
  })

  // Why: before worktree.ps resolves, scopeFilterPaths is empty on a scoped tab;
  // the builder must fall back to unnarrowed rather than filter to an empty list.
  it('falls back to unnarrowed when a scoped tab has no scopeFilterPaths yet', () => {
    const sessions = [
      session({ id: 'claude:a', cwd: '/Users/ada/repo/app' }),
      session({ id: 'claude:b', cwd: '/Users/ada/elsewhere' })
    ]
    const sections = buildMobileAgentHistorySections(sessions, {
      query: '',
      scope: 'workspace',
      scopeFilterPaths: [],
      activeWorktreePath: null,
      now: NOW
    })
    expect(
      sections
        .flatMap((s) => s.data)
        .map((card) => card.id)
        .sort()
    ).toEqual(['claude:a', 'claude:b'])
  })

  it('shows all sessions under All scope regardless of path', () => {
    const sessions = [
      session({ id: 'claude:a', cwd: '/Users/ada/repo/app' }),
      session({ id: 'claude:b', cwd: '/Users/ada/elsewhere' })
    ]
    const sections = buildMobileAgentHistorySections(sessions, {
      query: '',
      scope: 'all',
      scopeFilterPaths: [],
      activeWorktreePath: '/Users/ada/repo/app',
      now: NOW
    })
    expect(
      sections
        .flatMap((s) => s.data)
        .map((card) => card.id)
        .sort()
    ).toEqual(['claude:a', 'claude:b'])
  })
})

describe('MOBILE_AI_VAULT_CAPABILITY', () => {
  it('stays in lockstep with the host AI_VAULT_RUNTIME_CAPABILITY string', () => {
    // Why: mobile's protocol-version copy lacks the host constant; this literal
    // must match src/shared/protocol-version.ts AI_VAULT_RUNTIME_CAPABILITY.
    expect(MOBILE_AI_VAULT_CAPABILITY).toBe('aiVault.v1')
  })
})

describe('shouldShowMobileCurrentWorktreeBadge', () => {
  it('hides the repeated current-worktree badge in Workspace scope', () => {
    expect(shouldShowMobileCurrentWorktreeBadge('workspace')).toBe(false)
  })

  it('keeps the badge in mixed Project and All scopes', () => {
    expect(shouldShowMobileCurrentWorktreeBadge('project')).toBe(true)
    expect(shouldShowMobileCurrentWorktreeBadge('all')).toBe(true)
  })
})
