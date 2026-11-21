import { describe, expect, it } from 'vitest'
import type { VoiceRosterEntry } from './voice-control-roster'
import { buildAgentPaneFocusMessages } from './voice-control-pane-focus'

function entry(paneKey: string): VoiceRosterEntry {
  return {
    spokenName: 'oak',
    worktreeId: 'w1',
    repoId: 'r1',
    paneKey,
    agentType: 'claude',
    state: 'working',
    taskTitle: null,
    toolName: null,
    worktreePath: '/tmp/x',
    hostId: null
  }
}

describe('buildAgentPaneFocusMessages', () => {
  it('builds activate-worktree then focus-terminal for a valid pane key', () => {
    const messages = buildAgentPaneFocusMessages(
      entry('tab-9:123e4567-e89b-12d3-a456-426614174000')
    )
    expect(messages).toEqual([
      { channel: 'ui:activateWorktree', payload: { repoId: 'r1', worktreeId: 'w1' } },
      {
        channel: 'ui:focusTerminal',
        payload: {
          tabId: 'tab-9',
          worktreeId: 'w1',
          leafId: '123e4567-e89b-12d3-a456-426614174000',
          ackPaneKeyOnSuccess: 'tab-9:123e4567-e89b-12d3-a456-426614174000',
          flashFocusedPane: true,
          scrollToBottomIfOutputSinceLastView: true
        }
      }
    ])
  })

  it('returns null for an unparseable pane key', () => {
    expect(buildAgentPaneFocusMessages(entry('no-separator'))).toBeNull()
    expect(buildAgentPaneFocusMessages(entry('a:b:c'))).toBeNull()
  })
})
