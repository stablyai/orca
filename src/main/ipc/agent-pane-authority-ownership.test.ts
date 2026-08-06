import { describe, expect, it, vi } from 'vitest'
import { createAgentPaneAuthorityOwnership } from './agent-pane-authority-ownership'

describe('agent pane authority ownership', () => {
  it('accepts only the PTY bound to the physical local pane', () => {
    const ownsPty = createAgentPaneAuthorityOwnership({
      getPtyIdForPaneKey: (paneKey) => (paneKey === 'source-pane' ? 'pty-1' : undefined)
    })

    expect(ownsPty('source-pane', 'pty-1')).toBe(true)
    expect(ownsPty('source-pane', 'pty-forged')).toBe(false)
    expect(ownsPty('other-pane', 'pty-1')).toBe(false)
  })

  it('matches scoped and legacy runtime IDs to the authoritative terminal handle', () => {
    const getRuntimeTerminalHandleForPaneKey = vi.fn(() => 'terminal:one')
    const ownsPty = createAgentPaneAuthorityOwnership({
      getRuntimeTerminalHandleForPaneKey
    })

    expect(ownsPty('source-pane', 'remote:terminal:one')).toBe(true)
    expect(ownsPty('source-pane', 'remote:env-1@@terminal%3Aone')).toBe(true)
    expect(ownsPty('source-pane', 'remote:env-1@@other')).toBe(false)
    expect(ownsPty('source-pane', 'remote:env-1@@%E0%A4%A')).toBe(false)
    expect(ownsPty('source-pane', 'remote:@@terminal%3Aone')).toBe(false)
    expect(ownsPty('source-pane', 'remote:%20@@terminal%3Aone')).toBe(false)
    expect(ownsPty('source-pane', 'remote:env-1@@')).toBe(false)
    expect(ownsPty('source-pane', 'remote:env-1@@terminal:one')).toBe(false)
    expect(ownsPty('source-pane', 'remote:terminal%3Aone')).toBe(false)
  })
})
