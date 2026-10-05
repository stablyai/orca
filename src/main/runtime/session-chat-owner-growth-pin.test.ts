import { describe, expect, it } from 'vitest'
import { pinSessionChatOwnersOnGrowth } from './session-chat-owner-growth-pin'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'

const single: TerminalLayoutSnapshot = {
  root: { type: 'leaf', leafId: 'L' },
  activeLeafId: 'L',
  expandedLeafId: null
}
const grown: TerminalLayoutSnapshot = {
  root: {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: 'L' },
    second: { type: 'leaf', leafId: 'N' }
  },
  activeLeafId: 'N',
  expandedLeafId: null
}

function session(
  layout: TerminalLayoutSnapshot,
  viewMode?: 'terminal' | 'chat'
): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {
      wt: [
        {
          id: 'tab',
          ptyId: null,
          worktreeId: 'wt',
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ...(viewMode ? { viewMode } : {})
        }
      ]
    },
    terminalLayoutsByTabId: { tab: layout }
  }
}

describe('pinSessionChatOwnersOnGrowth', () => {
  it('pins an ownerless chat to its only pre-growth pane', () => {
    const next = pinSessionChatOwnersOnGrowth(session(single, 'chat'), session(grown, 'chat'))
    expect(next.terminalLayoutsByTabId.tab?.chatLeafId).toBe('L')
  })

  it('returns the same session when nothing pins', () => {
    const prior = session(single, 'chat')
    for (const next of [
      session(grown, 'terminal'),
      session(grown),
      session({ ...grown, chatLeafId: 'N' }, 'chat'),
      session(single, 'chat'),
      { ...prior, activeTabId: 'tab' }
    ]) {
      expect(pinSessionChatOwnersOnGrowth(prior, next)).toBe(next)
    }
    const fresh = session(grown, 'chat')
    expect(pinSessionChatOwnersOnGrowth(null, fresh)).toBe(fresh)
  })
})
