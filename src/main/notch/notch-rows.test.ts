import { describe, expect, it } from 'vitest'
import type { NotchSession } from '../../shared/notch/notch-status-summary'
import { buildNotchRows, type NotchWorkspaceLookup } from './notch-rows'

const LEAF = '0b6f5b3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b'

function session(overrides: Partial<NotchSession> = {}): NotchSession {
  return {
    paneKey: `tab-1:${LEAF}`,
    lane: 'working',
    state: 'working',
    stateStartedAt: 1_000,
    connectionId: null,
    ...overrides
  }
}

const lookup = (names: Record<string, string>): NotchWorkspaceLookup => ({
  getDisplayName: (worktreeId) => names[worktreeId] ?? null
})

describe('buildNotchRows', () => {
  it('titles a row with its workspace display name', () => {
    const [row] = buildNotchRows({
      sessions: [session({ worktreeId: 'repo-1::/w/a' })],
      lookup: lookup({ 'repo-1::/w/a': 'checkout-fix' }),
      fallbackTitle: 'Agent'
    })

    expect(row.title).toBe('checkout-fix')
  })

  it('derives the repo id from the worktree id for reveal', () => {
    const [row] = buildNotchRows({
      sessions: [session({ worktreeId: 'repo-1::/w/a' })],
      lookup: lookup({}),
      fallbackTitle: 'Agent'
    })

    expect(row.repoId).toBe('repo-1')
  })

  it('splits the pane key into tab and leaf so a click can route', () => {
    const [row] = buildNotchRows({
      sessions: [session({ worktreeId: 'repo-1::/w/a' })],
      lookup: lookup({}),
      fallbackTitle: 'Agent'
    })

    expect(row.tabId).toBe('tab-1')
    expect(row.leafId).toBe(LEAF)
  })

  it('prefers the payload tab id over the pane key', () => {
    const [row] = buildNotchRows({
      sessions: [session({ tabId: 'tab-explicit' })],
      lookup: lookup({}),
      fallbackTitle: 'Agent'
    })

    expect(row.tabId).toBe('tab-explicit')
  })

  it('leaves a malformed pane key unroutable rather than guessing', () => {
    const [row] = buildNotchRows({
      sessions: [session({ paneKey: 'not-a-pane-key' })],
      lookup: lookup({}),
      fallbackTitle: 'Agent'
    })

    expect(row.leafId).toBeNull()
    expect(row.tabId).toBeNull()
  })

  it('falls back to the agent type when the workspace is unknown', () => {
    const [row] = buildNotchRows({
      sessions: [session({ worktreeId: 'repo-1::/gone', agentType: 'claude' })],
      lookup: lookup({}),
      fallbackTitle: 'Agent'
    })

    expect(row.title).toBe('claude')
  })

  it('names a folder workspace and leaves its subtitle empty', () => {
    // Why: folder workspaces have no git identity, so there is no branch line to render.
    const [row] = buildNotchRows({
      sessions: [session({ worktreeId: 'folder:notes-1' })],
      lookup: lookup({ 'folder:notes-1': 'design-notes' }),
      fallbackTitle: 'Agent'
    })

    expect(row.title).toBe('design-notes')
    expect(row.subtitle).toBe('')
  })

  it('handles a session with no workspace attribution at all', () => {
    const [row] = buildNotchRows({
      sessions: [session({ worktreeId: undefined })],
      lookup: lookup({}),
      fallbackTitle: 'Agent'
    })

    expect(row.title).toBe('Agent')
    expect(row.worktreeId).toBeNull()
    expect(row.repoId).toBeNull()
  })

  it('preserves lane and state so the row dot matches the bar', () => {
    const [row] = buildNotchRows({
      sessions: [session({ lane: 'attention', state: 'blocked' })],
      lookup: lookup({}),
      fallbackTitle: 'Agent'
    })

    expect(row.lane).toBe('attention')
    expect(row.state).toBe('blocked')
  })

  it('keeps session order', () => {
    const rows = buildNotchRows({
      sessions: [
        session({ paneKey: `tab-1:${LEAF}` }),
        session({ paneKey: `tab-2:${LEAF}` }),
        session({ paneKey: `tab-3:${LEAF}` })
      ],
      lookup: lookup({}),
      fallbackTitle: 'Agent'
    })

    expect(rows.map((row) => row.tabId)).toEqual(['tab-1', 'tab-2', 'tab-3'])
  })
})
