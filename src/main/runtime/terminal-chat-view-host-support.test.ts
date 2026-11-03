import { describe, expect, it } from 'vitest'
import {
  terminalChatViewRefusal,
  terminalCreateChatViewParamsRefusal
} from './terminal-chat-view-host-support'

describe('terminalChatViewRefusal', () => {
  it('refuses an agent without a Chat UI view', () => {
    expect(
      terminalChatViewRefusal({ commandAgent: 'gemini', plannedAgent: null, connectionId: null })
        ?.message
    ).toMatch(/Gemini has no Chat UI view/)
  })

  it('refuses over SSH only for agents whose transcript must be local', () => {
    expect(
      terminalChatViewRefusal({
        commandAgent: 'opencode',
        plannedAgent: null,
        connectionId: 'ssh-1'
      })?.message
    ).toMatch(/over SSH/)
    expect(
      terminalChatViewRefusal({ commandAgent: 'claude', plannedAgent: null, connectionId: 'ssh-1' })
    ).toBeNull()
  })
})

describe('terminalCreateChatViewParamsRefusal', () => {
  it.each([
    [{ viewMode: 'chat', worktree: 'id:w' }, /given together/],
    [{ commandAgent: 'claude', worktree: 'id:w' }, /given together/],
    [{ viewMode: 'terminal', commandAgent: 'claude', worktree: 'id:w' }, /given together/],
    [{ viewMode: 'chat', commandAgent: 'claude' }, /needs a worktree/],
    [{ viewMode: 'chat', commandAgent: 'claude', worktree: 'id:w' }, /pass --command/],
    [
      { viewMode: 'chat', commandAgent: 'claude', worktree: 'id:w', command: '  ' },
      /pass --command/
    ],
    [
      {
        viewMode: 'chat',
        commandAgent: 'claude',
        worktree: 'id:w',
        command: 'codex --full-auto'
      },
      /contradicts codex/
    ]
  ] as const)('refuses %o', (params, message) => {
    expect(terminalCreateChatViewParamsRefusal(params)?.message).toMatch(message)
  })

  it('admits a chat request with its agent and worktree, and a plain create', () => {
    expect(
      terminalCreateChatViewParamsRefusal({
        viewMode: 'chat',
        commandAgent: 'claude',
        worktree: 'id:w',
        command: './start-agent.sh'
      })
    ).toBeNull()
    expect(terminalCreateChatViewParamsRefusal({})).toBeNull()
  })
})
