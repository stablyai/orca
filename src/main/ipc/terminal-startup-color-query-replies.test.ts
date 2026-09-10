import { describe, expect, it } from 'vitest'
import { getStartupTerminalColorQueryReplyColors } from './terminal-startup-color-query-replies'

const REPLIES = { foreground: '#ffffff', background: '#282c34' }

describe('getStartupTerminalColorQueryReplyColors', () => {
  it('arms replies for TUI agents that consume them', () => {
    expect(
      getStartupTerminalColorQueryReplyColors({
        launchAgent: 'codex',
        terminalColorQueryReplies: REPLIES
      })
    ).toEqual(REPLIES)
    expect(
      getStartupTerminalColorQueryReplyColors({
        launchAgent: 'claude',
        terminalColorQueryReplies: REPLIES
      })
    ).toEqual(REPLIES)
  })

  it('does not arm replies for jcode', () => {
    // Why: jcode's startup OSC burst is answered before its input loop is
    // ready, so the cooked reply lands in the composer as `10;rgb:…` text
    // (same class as issue #12112, which fixed opencode).
    expect(
      getStartupTerminalColorQueryReplyColors({
        launchAgent: 'jcode',
        terminalColorQueryReplies: REPLIES
      })
    ).toBeNull()
  })
})
