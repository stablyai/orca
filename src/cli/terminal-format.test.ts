import { describe, expect, it } from 'vitest'
import { formatTerminalClose, formatTerminalFocus } from './terminal-format'

describe('formatTerminalFocus', () => {
  it('distinguishes superseded navigation from a winning focus', () => {
    expect(
      formatTerminalFocus({
        focus: {
          handle: 'term_stale',
          tabId: 'tab-stale',
          worktreeId: 'worktree-1',
          navigated: false
        }
      })
    ).toBe(
      'Focus request for terminal term_stale was superseded or host navigation was skipped (tab tab-stale).'
    )
    expect(
      formatTerminalFocus({
        focus: { handle: 'term_winner', tabId: 'tab-winner', worktreeId: 'worktree-1' }
      })
    ).toBe('Focused terminal term_winner (tab tab-winner).')
  })
})

describe('formatTerminalClose', () => {
  it('prints "PTY killed." only for a confirmed kill', () => {
    expect(
      formatTerminalClose({ close: { handle: 'term_local', tabId: 'tab-1', ptyKilled: true } })
    ).toBe('Closed terminal term_local. PTY killed.')
  })

  it('says the remote process was not confirmed stopped instead of claiming a kill', () => {
    expect(
      formatTerminalClose({
        close: {
          handle: 'term_remote',
          tabId: 'tab-1',
          ptyKilled: false,
          ptyStopVerdict: 'unverifiable',
          ptyStopReason: 'its SSH provider is no longer registered'
        }
      })
    ).toBe(
      'Closed terminal term_remote. The PTY was not confirmed stopped: its SSH provider is no longer registered.'
    )
  })

  it('names a PTY known to be live', () => {
    expect(
      formatTerminalClose({
        close: {
          handle: 'term_live',
          tabId: 'tab-1',
          ptyKilled: false,
          ptyStopVerdict: 'live'
        }
      })
    ).toBe('Closed terminal term_live. The PTY is live.')
  })
})
