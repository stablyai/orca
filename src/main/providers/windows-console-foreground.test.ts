import { describe, expect, it } from 'vitest'
import { canConfirmAgentFromConsolePresence } from './windows-console-foreground'

describe('canConfirmAgentFromConsolePresence', () => {
  it('is true for a cached agent when node-pty only names the shell (a scan would run)', () => {
    expect(canConfirmAgentFromConsolePresence('claude', 'powershell.exe')).toBe(true)
    expect(canConfirmAgentFromConsolePresence('codex', 'cmd.exe')).toBe(true)
  })

  it('is false when node-pty already names a recognized agent (no scan needed)', () => {
    // Nothing to save here — the fast no-scan path already returns the agent.
    expect(canConfirmAgentFromConsolePresence('claude', 'claude')).toBe(false)
  })

  it('is false for a generic wrapper that may outlive the cached agent', () => {
    expect(canConfirmAgentFromConsolePresence('claude', 'node.exe')).toBe(false)
  })

  it('is false when no agent has been recognized yet (identity must be established first)', () => {
    expect(canConfirmAgentFromConsolePresence(null, 'powershell.exe')).toBe(false)
  })

  it('is false when there is no fallback process name', () => {
    expect(canConfirmAgentFromConsolePresence('claude', null)).toBe(false)
  })
})
