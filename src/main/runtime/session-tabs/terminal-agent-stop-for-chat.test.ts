import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import {
  stopTerminalAgentForChat,
  type TerminalAgentStopPreparation
} from './terminal-agent-stop-for-chat'

const row: AgentStatusIpcPayload = {
  paneKey: 'source',
  worktreeId: 'workspace',
  connectionId: null,
  agentType: 'claude',
  receivedAt: 1,
  stateStartedAt: 1,
  state: 'done',
  prompt: '',
  providerSession: { key: 'session_id', id: 'conversation' }
}
afterEach(() => vi.useRealTimers())

describe('terminal stop admission order', () => {
  it.each([
    'conversationMoved',
    'agentPaused',
    'otherHolder',
    'transcriptNotFound',
    'sharedServer'
  ] as const)('refuses %s before interrupting or stopping', async (reason) => {
    const stop = vi.fn(async () => 'exited' as const)
    const interrupt = vi.fn(async () => ({ outcome: 'accepted' }))
    const prepared: TerminalAgentStopPreparation = {
      hasAgent: true,
      paused: reason === 'agentPaused',
      current: () => reason !== 'conversationMoved',
      released: async () => true,
      stop,
      beforeInterrupt: async () => {}
    }
    const latest: AgentStatusIpcPayload = {
      ...row,
      state: reason === 'agentPaused' ? 'working' : 'done'
    }
    const expected =
      reason === 'otherHolder'
        ? 'agent_session_conflict'
        : reason === 'transcriptNotFound'
          ? 'agent_session_identity_required'
          : 'agent_session_operation_invalid'
    await expect(
      stopTerminalAgentForChat({
        readRow: () => latest,
        prepare: async () => prepared,
        predict: async () => {
          if (reason === 'otherHolder') {
            throw agentSessionRefusalError('agent_session_conflict', {
              reason: 'conversationHeldElsewhere'
            })
          }
          if (reason === 'transcriptNotFound') {
            throw agentSessionRefusalError('agent_session_identity_required', {
              reason: 'transcriptNotFound'
            })
          }
          if (reason === 'sharedServer') {
            throw agentSessionRefusalError('agent_session_operation_invalid', {
              reason: 'writerTopologyUnproven'
            })
          }
        },
        interrupt,
        subscribe: () => () => {}
      })
    ).rejects.toThrow(expected)
    expect(stop).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('bounds the accepted Escape wait and never resumes an interrupted turn', async () => {
    vi.useFakeTimers()
    const stop = vi.fn(async () => 'exited' as const)
    const input = {
      readRow: () => ({ ...row, state: 'working' as const }),
      prepare: async () => ({
        hasAgent: true,
        paused: false,
        current: () => true,
        released: async () => true,
        stop,
        beforeInterrupt: async () => {}
      }),
      predict: async () => {},
      interrupt: vi.fn(async () => ({ outcome: 'accepted' })),
      subscribe: () => () => {}
    }
    const result = stopTerminalAgentForChat(input)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(stop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual({ ok: true })
    expect(stop).toHaveBeenCalledOnce()
    expect(input.interrupt).toHaveBeenCalledOnce()
  })
})
