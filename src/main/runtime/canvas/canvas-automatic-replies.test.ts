import { afterEach, describe, expect, it } from 'vitest'
import { normalizePromptField } from '../../../shared/agent-status-field-normalization'
import type { EnrichedAgentHookEventPayload } from '../../agent-hooks/server'
import type { OrchestrationDb } from '../orchestration/db'
import { canvasMessagingFixture } from './canvas-messaging-test-fixture'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

describe('automatic canvas replies', () => {
  it('never forwards the answer to a new user prompt on the same terminal', async () => {
    const f = await canvasMessagingFixture()
    databases.push(f.db)
    f.runtime.getTerminalAgentStatus.mockResolvedValue({ isRunningAgent: true, status: 'idle' })
    f.service.send(f.input())
    await f.settle()
    const prompt = normalizePromptField(f.runtime.sendTerminalAgentPrompt.mock.calls[0][1])
    const event: EnrichedAgentHookEventPayload = {
      paneKey: 'b',
      worktreeId: 'folder-workspace',
      connectionId: null,
      source: 'codex',
      launchToken: 'b',
      providerSession: { key: 'session_id', id: 'session-b' },
      receivedAt: Date.now(),
      stateStartedAt: Date.now(),
      hasExplicitPrompt: true,
      hookEventName: 'UserPromptSubmit',
      payload: { state: 'working', prompt, agentType: 'codex' }
    }
    f.service.observeAgentHook(event)
    f.service.observeAgentHook({
      ...event,
      payload: { ...event.payload, prompt: 'A new private user request' }
    })
    f.service.observeAgentHook({
      ...event,
      hasExplicitPrompt: false,
      hookEventName: 'Stop',
      payload: {
        state: 'done',
        prompt: 'A new private user request',
        agentType: 'codex',
        lastAssistantMessage: 'Do not share this answer'
      }
    })
    expect(f.service.inbox('canvas', 'a', 'a')).toEqual([])
  })
  it('returns a normal final answer to the sender without a canvas send command', async () => {
    const f = await canvasMessagingFixture()
    databases.push(f.db)
    f.runtime.getTerminalAgentStatus.mockResolvedValue({ isRunningAgent: true, status: 'idle' })
    const message = f.service.send({ ...f.input(), body: 'What is the fifth Fibonacci number?' })
    await f.settle()
    const prompt = normalizePromptField(f.runtime.sendTerminalAgentPrompt.mock.calls[0][1])
    const event: EnrichedAgentHookEventPayload = {
      paneKey: 'b',
      worktreeId: 'folder-workspace',
      connectionId: null,
      source: 'codex',
      launchToken: 'b',
      providerSession: { key: 'session_id', id: 'session-b' },
      receivedAt: Date.now(),
      stateStartedAt: Date.now(),
      hasExplicitPrompt: true,
      hookEventName: 'UserPromptSubmit',
      payload: { state: 'working', prompt, agentType: 'codex' }
    }
    f.service.observeAgentHook(event)
    f.runtime.getTerminalAgentStatus.mockResolvedValue({ isRunningAgent: true, status: 'working' })
    f.service.observeAgentHook({
      ...event,
      hasExplicitPrompt: false,
      hookEventName: 'Stop',
      payload: {
        state: 'done',
        prompt,
        agentType: 'codex',
        lastAssistantMessage: 'Starting at 0: 3. Starting at 1: 5.'
      }
    })
    await f.settle()
    expect(f.service.inbox('canvas', 'a', 'a')).toEqual([
      expect.objectContaining({
        replyTo: message.id,
        kind: 'reply',
        body: 'Starting at 0: 3. Starting at 1: 5.'
      })
    ])
  })
})
