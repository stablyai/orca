import {
  acquireReadyCodexForTest,
  THREAD_ID,
  acquired,
  adapterFor,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'
import { describe, expect, it, vi } from 'vitest'
import { AgentSessionPromptAnswerRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

describe('CodexStructuredSessionAdapter prompts', () => {
  function askApproval(codex: ReturnType<typeof fakeCodex>): void {
    codex.connections[0].handlers.onServerRequest?.({
      id: 11,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'codex-item-1', threadId: THREAD_ID, turnId: 'turn-1' }
    })
  }

  it('surfaces an approval request and answers it exactly once', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    const adapter = await acquired(codex, {}, events)

    askApproval(codex)
    adapter.bindPromptItemId('session-1', 'codex:thread-abc:turn-1:3', 'codex-item-1')
    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'codex:thread-abc:turn-1:3',
      kind: 'approval',
      response: { kind: 'option', optionId: 'accept' },
      fence: 7,
      commit: async () => undefined
    })

    expect(events.at(-1)).toMatchObject({ type: 'prompt', codexItemId: 'codex-item-1' })
    expect(codex.connections[0].replies).toEqual([{ id: 11, result: { decision: 'accept' } }])

    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: 'codex:thread-abc:turn-1:3',
        kind: 'approval',
        response: { kind: 'option', optionId: 'decline' },
        fence: 7,
        commit: async () => undefined
      })
    ).rejects.toThrow('no longer waiting on')
    expect(codex.connections[0].replies).toHaveLength(1)
  })

  it('responds with an error when a prompt cannot be admitted to the journal sink', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      tryAppendItem: vi.fn(() => ({ accepted: false as const, reason: 'closed' as const }))
    }
    const adapter = adapterFor(codex, {}, events)
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: sink
    })

    askApproval(codex)

    expect(events.filter((event) => event.type === 'prompt')).toEqual([])
    expect(codex.connections[0].replies).toEqual([
      {
        id: 11,
        code: -32001,
        message:
          'Orca could not durably record item/commandExecution/requestApproval prompt (closed)'
      }
    ])
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: 'codex-item-1',
        kind: 'approval',
        response: { kind: 'option', optionId: 'accept' },
        fence: 7,
        commit: async () => undefined
      })
    ).rejects.toThrow('no longer waiting on')
  })

  it('force-closes when an unhandled provider frame cannot be admitted', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      tryAppendItem: vi.fn(() => ({ accepted: false as const, reason: 'backpressure' as const }))
    }
    const adapter = adapterFor(codex, {}, events)
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: sink
    })

    codex.connections[0].handlers.onUnhandledFrame?.('frame:invalid-json', '{')

    await vi.waitFor(() => expect(codex.connections[0].closeCount).toBe(1))
    expect(events.filter((event) => event.type === 'ended')).toMatchObject([
      { cause: 'unexpected-exit', fence: 7, acquisitionGeneration: 'generation-1' }
    ])
  })

  it('force-closes after a responded server request is not durably admitted', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      tryAppendItem: vi.fn(() => ({ accepted: false as const, reason: 'failed' as const }))
    }
    const adapter = adapterFor(codex, {}, events)
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: sink
    })

    codex.connections[0].handlers.onServerRequest?.({
      id: 17,
      method: 'item/permissions/requestApproval',
      params: { threadId: THREAD_ID }
    })

    await vi.waitFor(() => expect(codex.connections[0].closeCount).toBe(1))
    expect(events.filter((event) => event.type === 'ended')).toMatchObject([
      { cause: 'unexpected-exit', fence: 7, acquisitionGeneration: 'generation-1' }
    ])
  })

  it('answers each approval a tool item asks for separately', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    const adapter = await acquired(codex, {}, events)
    // A shell bridge re-asks per command under one parent tool item, so only the
    // approval id tells the two requests apart.
    const ask = (id: number, approvalId: string): void => {
      codex.connections[0].handlers.onServerRequest?.({
        id,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'codex-item-1', approvalId, threadId: THREAD_ID, turnId: 'turn-1' }
      })
    }

    ask(11, 'approval-a')
    ask(12, 'approval-b')
    adapter.bindPromptItemId('session-1', 'journal-a', 'approval-a')
    adapter.bindPromptItemId('session-1', 'journal-b', 'approval-b')
    for (const [itemId, optionId] of [
      ['journal-b', 'decline'],
      ['journal-a', 'accept']
    ]) {
      await adapter.answerPrompt({
        sessionId: 'session-1',
        itemId,
        kind: 'approval',
        response: { kind: 'option', optionId },
        fence: 7,
        commit: async () => undefined
      })
    }

    expect(codex.connections[0].replies).toEqual([
      { id: 12, result: { decision: 'decline' } },
      { id: 11, result: { decision: 'accept' } }
    ])
    expect(events.map((event) => (event.type === 'prompt' ? event.promptKey : null))).toEqual([
      'approval-a',
      'approval-b'
    ])
  })

  it('rejects an option id that is not a Codex decision', async () => {
    const codex = fakeCodex()
    const adapter = await acquired(codex)

    askApproval(codex)
    const commit = vi.fn(async () => undefined)

    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: 'codex-item-1',
        kind: 'approval',
        response: { kind: 'option', optionId: 'yolo' },
        fence: 7,
        commit
      })
    ).rejects.toThrow(AgentSessionPromptAnswerRejectedError)
    // Refused before the journal records an answer the agent never receives.
    expect(commit).not.toHaveBeenCalled()
    expect(codex.connections[0].replies).toEqual([])
  })

  it('holds a multi-question request until every question is answered', async () => {
    const codex = fakeCodex()
    const adapter = await acquired(codex)
    codex.connections[0].handlers.onServerRequest?.({
      id: 12,
      method: 'item/tool/requestUserInput',
      params: {
        itemId: 'codex-item-2',
        threadId: THREAD_ID,
        turnId: 'turn-1',
        questions: [
          { id: 'q1', question: 'Use this answer?' },
          { id: 'q2', question: 'Use that answer?' }
        ]
      }
    })

    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'codex-item-2',
      kind: 'question',
      response: { kind: 'answers', answers: [{ questionId: 'q1', optionIds: [], other: 'yes' }] },
      fence: 7,
      commit: async () => undefined
    })
    expect(codex.connections[0].replies).toEqual([])

    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'codex-item-2',
      kind: 'question',
      response: { kind: 'answers', answers: [{ questionId: 'q2', optionIds: [], other: 'no' }] },
      fence: 7,
      commit: async () => undefined
    })

    expect(codex.connections[0].replies).toEqual([
      { id: 12, result: { answers: { q1: { answers: ['yes'] }, q2: { answers: ['no'] } } } }
    ])
  })

  it('declines MCP elicitation and journals the explicit disposition', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    await acquired(codex, {}, events)

    codex.connections[0].handlers.onServerRequest?.({
      id: 13,
      method: 'mcpServer/elicitation/request',
      params: { itemId: 'codex-item-3', threadId: THREAD_ID }
    })

    expect(codex.connections[0].replies).toEqual([
      { id: 13, result: { action: 'decline', content: null, _meta: null } }
    ])
    expect(events.some((event) => event.type === 'prompt')).toBe(false)
  })

  it('surfaces an answer to a prompt Codex already forgot', async () => {
    const codex = fakeCodex()
    const adapter = await acquired(codex)

    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: 'codex-item-gone',
        kind: 'approval',
        response: { kind: 'option', optionId: 'accept' },
        fence: 7,
        commit: async () => undefined
      })
    ).rejects.toThrow('no longer waiting on codex-item-gone')
  })
})
