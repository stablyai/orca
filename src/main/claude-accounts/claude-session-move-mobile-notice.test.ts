import { describe, expect, it, vi } from 'vitest'
import { account } from './claude-session-mover-test-fixture'
import type { ClaudeSessionMoveNotice } from './claude-session-mover-types'
import {
  CLAUDE_RECENT_MOVES_ATTENTION_KEY,
  claudeRecentMovesMobileNotification,
  dispatchClaudeRecentMoves
} from './claude-session-move-mobile-notice'

const notice: ClaudeSessionMoveNotice = {
  kind: 'moved',
  ptyId: 'pty-old',
  paneKey: 'tab-1:leaf-1',
  from: account('acct-a', { email: 'a@example.test' }),
  to: account('acct-b', { email: 'b@example.test' }),
  detail: 'pty-new',
  moves: [
    {
      ptyId: 'pty-new',
      paneKey: 'tab-1:leaf-1',
      fromAccountId: 'acct-a',
      toAccountId: 'acct-b',
      window: 'session',
      percent: 96,
      line: 95,
      reason: 'moved',
      at: Date.parse('2026-10-29T15:04:05.000Z'),
      strategy: 'proxy'
    },
    {
      ptyId: 'pty-stay',
      paneKey: null,
      fromAccountId: 'acct-b',
      toAccountId: null,
      window: null,
      percent: null,
      line: null,
      reason: 'stay',
      at: Date.parse('2026-10-29T15:00:00.000Z')
    }
  ]
}

describe('recent moves on the mobile notification stream', () => {
  it('sends the same rows orca account moves prints', () => {
    expect(claudeRecentMovesMobileNotification(notice, 'Recent moves')).toEqual({
      type: 'notification',
      source: 'plugin',
      title: 'Recent moves',
      attentionKey: CLAUDE_RECENT_MOVES_ATTENTION_KEY,
      paneKey: 'tab-1:leaf-1',
      body: [
        '2026-10-29T15:04:05.000Z  tab-1:leaf-1  acct-a → acct-b  moved  proxy',
        '2026-10-29T15:00:00.000Z  pty-stay  acct-b → -  stay  -'
      ].join('\n')
    })
  })

  it('skips an empty list and a missing dispatcher', () => {
    expect(claudeRecentMovesMobileNotification({ ...notice, moves: [] }, 'Recent moves')).toBeNull()
    const dispatch = vi.fn()
    dispatchClaudeRecentMoves(undefined, notice, 'Recent moves')
    dispatchClaudeRecentMoves(dispatch, { ...notice, moves: [] }, 'Recent moves')
    expect(dispatch).not.toHaveBeenCalled()
  })
})
