import { describe, expect, it } from 'vitest'
import {
  shouldDismissKeyboardAfterTerminalSend,
  type AgentSendKeyboardDismissalTab
} from './agent-send-keyboard-dismissal'

function terminalTab(overrides: Partial<AgentSendKeyboardDismissalTab> = {}) {
  return { type: 'terminal', title: 'Terminal', ...overrides }
}

describe('shouldDismissKeyboardAfterTerminalSend', () => {
  it('dismisses for a live agent session', () => {
    expect(
      shouldDismissKeyboardAfterTerminalSend(
        terminalTab({ agentStatus: { agentType: 'claude' } }),
        true
      )
    ).toBe(true)
  })

  it('dismisses off launchAgent before the first agent-status update lands', () => {
    expect(
      shouldDismissKeyboardAfterTerminalSend(terminalTab({ launchAgent: 'codex' }), true)
    ).toBe(true)
  })

  it('keeps the keyboard when an agent send is rejected', () => {
    expect(
      shouldDismissKeyboardAfterTerminalSend(
        terminalTab({ agentStatus: { agentType: 'claude' } }),
        false
      )
    ).toBe(false)
  })

  it('keeps the keyboard for a plain shell so back-to-back commands stay typeable', () => {
    expect(shouldDismissKeyboardAfterTerminalSend(terminalTab(), true)).toBe(false)
    expect(shouldDismissKeyboardAfterTerminalSend(terminalTab({ agentStatus: null }), true)).toBe(
      false
    )
  })

  it('treats a blank agent label as no agent', () => {
    // A truthy-empty agentType would otherwise dismiss on every shell Enter.
    expect(
      shouldDismissKeyboardAfterTerminalSend(terminalTab({ agentStatus: { agentType: '' } }), true)
    ).toBe(false)
    expect(
      shouldDismissKeyboardAfterTerminalSend(
        terminalTab({ agentStatus: { agentType: '  ' } }),
        true
      )
    ).toBe(false)
    expect(
      shouldDismissKeyboardAfterTerminalSend(
        terminalTab({
          agentStatus: { agentType: null },
          launchAgent: null
        }),
        true
      )
    ).toBe(false)
  })

  it('falls through to launchAgent only when live status carries no agent', () => {
    expect(
      shouldDismissKeyboardAfterTerminalSend(
        terminalTab({
          agentStatus: { agentType: null },
          launchAgent: 'claude'
        }),
        true
      )
    ).toBe(true)
  })

  it('never dismisses for non-terminal tabs or a missing tab', () => {
    expect(
      shouldDismissKeyboardAfterTerminalSend(
        {
          type: 'markdown',
          title: 'README.md',
          agentStatus: { agentType: 'claude' }
        },
        true
      )
    ).toBe(false)
    expect(shouldDismissKeyboardAfterTerminalSend(null, true)).toBe(false)
    expect(shouldDismissKeyboardAfterTerminalSend(undefined, true)).toBe(false)
  })

  it('does not authorize dismissal from unknown status or a display-only title', () => {
    expect(
      shouldDismissKeyboardAfterTerminalSend(
        terminalTab({ agentStatus: { agentType: 'unknown' } }),
        true
      )
    ).toBe(false)
    expect(
      shouldDismissKeyboardAfterTerminalSend(terminalTab({ title: '✦ Gemini CLI' }), true)
    ).toBe(false)
  })

  it.each(['zsh', 'bash', 'pwsh'])(
    'keeps the keyboard when identity-only done status is stale under %s',
    (title) => {
      expect(
        shouldDismissKeyboardAfterTerminalSend(
          terminalTab({
            title,
            agentStatus: { agentType: 'claude', state: 'done' },
            launchAgent: 'claude'
          }),
          true
        )
      ).toBe(false)
    }
  )

  it('still dismisses for a completed agent under a non-shell title', () => {
    expect(
      shouldDismissKeyboardAfterTerminalSend(
        terminalTab({
          title: 'Terminal',
          agentStatus: { agentType: 'claude', state: 'done' }
        }),
        true
      )
    ).toBe(true)
  })
})
