import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { HarnessConversationDriverFactory } from './driver'
import { MachineStructuredSessionAdapter } from './machine-structured-session-adapter'

const identity: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'worktree-1',
  hostId: 'local',
  agent: 'claude',
  providerHandle: { kind: 'opaque', agent: 'claude', value: 'pending' }
}

describe('MachineStructuredSessionAdapter', () => {
  it('acquires Claude and publishes a completed turn through the structured journal', async () => {
    const appendItem = vi.fn<StructuredAgentSessionEventSink['appendItem']>()
    const events: StructuredAgentSessionEventSink = {
      appendItem,
      appendTombstone: vi.fn(),
      publish: vi.fn()
    }
    const send = vi.fn(async () => undefined)
    const createDriver = vi.fn<HarnessConversationDriverFactory>(async (input) => {
      input.sink.setProcessId?.(123)
      return {
        ready: async () => undefined,
        send,
        interrupt: async () => undefined,
        answerPermission: () => undefined,
        answerInput: () => undefined,
        close: async () => undefined
      }
    })
    const adapter = new MachineStructuredSessionAdapter({
      createDriver,
      resolveWorkspacePath: async () => '/repo',
      readProcessStartTime: async () => 1_700_000_000_000,
      now: () => 1_700_000_000_500
    })

    const acquisition = await adapter.acquire({
      identity,
      fence: 7,
      spawnToken: 'spawn-1',
      events
    })
    const outcome = await adapter.dispatch({
      sessionId: identity.sessionId,
      clientMessageId: 'message-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'ship it' }] },
      fence: 7
    })
    await vi.waitFor(() =>
      expect(appendItem).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          kind: 'status',
          turnLifecycle: { turnId: 'message-1', state: 'completed', outcome: 'completed' }
        }),
        [],
        { lifecycle: true }
      )
    )

    expect(acquisition).toMatchObject({
      process: { hostId: 'local', pid: 123, spawnToken: 'spawn-1' },
      link: { handle: { provider: 'claude' }, origin: 'created', mintedAtFence: 7 }
    })
    expect(outcome.state).toBe('accepted')
    expect(send).toHaveBeenCalledWith('ship it', [])
  })
})
