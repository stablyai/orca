import { describe, expect, it, vi } from 'vitest'
import type { AgentProviderSessionMetadata } from '../../../src/shared/agent-session-resume'
import { getMobileAgentSessionTerminalActions } from './mobile-agent-session-terminal-actions'

vi.mock('lucide-react-native', () => ({ SquareTerminal: vi.fn() }))

const PROVIDER_SESSION: AgentProviderSessionMetadata = { key: 'session_id', id: 'provider-1' }

describe('mobile agent-session terminal actions', () => {
  it('offers the hand-off for a resumable chat whose provider session is known', () => {
    const onOpen = vi.fn()
    const actions = getMobileAgentSessionTerminalActions({
      tab: { sessionId: 'chat-1', agent: 'claude' },
      providerSession: PROVIDER_SESSION,
      onOpen
    })

    expect(actions.map((action) => action.label)).toEqual(['Open in Terminal'])
    actions[0]!.onPress()
    expect(onOpen).toHaveBeenCalledWith({
      sessionId: 'chat-1',
      agent: 'claude',
      providerSession: PROVIDER_SESSION
    })
  })

  it('offers nothing until a history read has named the provider session', () => {
    const onOpen = vi.fn()

    expect(
      getMobileAgentSessionTerminalActions({
        tab: { sessionId: 'chat-1', agent: 'claude' },
        providerSession: null,
        onOpen
      })
    ).toEqual([])
    expect(
      getMobileAgentSessionTerminalActions({
        tab: null,
        providerSession: PROVIDER_SESSION,
        onOpen
      })
    ).toEqual([])
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('offers the hand-off for Cursor, which supports TUI resume', () => {
    expect(
      getMobileAgentSessionTerminalActions({
        tab: { sessionId: 'chat-1', agent: 'cursor' },
        providerSession: PROVIDER_SESSION,
        onOpen: vi.fn()
      })
    ).toHaveLength(1)
  })

  it('offers nothing for an unknown agent with no TUI resume', () => {
    expect(
      getMobileAgentSessionTerminalActions({
        tab: { sessionId: 'chat-1', agent: 'unknown-agent' },
        providerSession: PROVIDER_SESSION,
        onOpen: vi.fn()
      })
    ).toEqual([])
  })
})
