import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type {
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionEventSink
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { ClaudeJournalPrompts } from './claude-structured-journal-prompts'
import { claudeQuestionItems } from './claude-structured-prompt-items'
import type { ClaudePendingPrompt } from './claude-structured-prompt-replies'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  PROVIDER_SESSION_ID,
  USER_MESSAGE,
  acquired,
  adapterFor,
  fakeClaude,
  identityFor,
  invokeCanUseTool
} from './claude-structured-session-test-support'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

function lifecycleRecorder(acceptPromptCancellation = true): {
  sink: StructuredAgentSessionEventSink
  bodies: Map<string, AgentJournalItemBody>
  tombstones: Set<string>
  order: string[]
} {
  const bodies = new Map<string, AgentJournalItemBody>()
  const tombstones = new Set<string>()
  const order: string[] = []
  const appendTombstone = (
    identity: Parameters<StructuredAgentSessionEventSink['appendTombstone']>[0],
    options?: StructuredAgentSessionAppendOptions
  ): void => {
    const key = agentJournalItemKey(identity)
    bodies.delete(key)
    tombstones.add(key)
    if (options?.lifecycle === true) {
      order.push('prompt-lifecycle')
    }
  }
  const appendItem = (
    identity: Parameters<StructuredAgentSessionEventSink['appendItem']>[0],
    body: Parameters<StructuredAgentSessionEventSink['appendItem']>[1],
    options?: StructuredAgentSessionAppendOptions
  ): void => {
    bodies.set(agentJournalItemKey(identity), body)
    if (options?.lifecycle === true) {
      order.push('prompt-lifecycle')
    }
  }
  const sink: StructuredAgentSessionEventSink = {
    appendItem,
    appendTombstone,
    tryAppendTombstone: (identity, options) => {
      if (!acceptPromptCancellation) {
        return { accepted: false, reason: 'backpressure' }
      }
      appendTombstone(identity, options)
      return { accepted: true }
    },
    tryAppendLifecycleBatch: (_settlementId, mutations, options) => {
      if (!acceptPromptCancellation) {
        return { accepted: false, reason: 'backpressure' }
      }
      for (const mutation of mutations) {
        if (mutation.kind === 'tombstone') {
          appendTombstone(mutation.identity, options)
        } else {
          appendItem(mutation.identity, mutation.body, options)
        }
      }
      return { accepted: true }
    },
    publish: (_options?: StructuredAgentSessionAppendOptions) => {},
    tryPublish: () => ({ accepted: true })
  }
  return { sink, bodies, tombstones, order }
}

async function startTurn(
  adapter: Awaited<ReturnType<typeof acquired>>,
  turnId = 'turn-1'
): Promise<void> {
  await adapter.dispatch({
    sessionId: 'session-1',
    clientMessageId: `client-${turnId}`,
    body: USER_MESSAGE,
    fence: 7
  })
}

describe('Claude live prompt ownership', () => {
  it('lets an answer hold the callback claim through its journal commit', async () => {
    const claude = fakeClaude({ replayUuid: 'turn-1' })
    const adapter = await acquired(claude)
    await startTurn(adapter)
    const connection = claude.connections[0]
    if (!connection) {
      throw new Error('expected Claude connection')
    }
    const answered = invokeCanUseTool(connection, 'Bash', 'permission-1', 'tool-1', {
      input: { command: 'git status' }
    })
    adapter.bindPromptItemId('session-1', 'journal-prompt', 'permission-1')
    const commitGate = deferred()
    const commitStarted = vi.fn()

    const answer = adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'journal-prompt',
      kind: 'approval',
      optionId: 'allow',
      fence: 7,
      commit: async () => {
        expect(answered.settled()).toBe(false)
        commitStarted()
        await commitGate.promise
      }
    })
    await vi.waitFor(() => expect(commitStarted).toHaveBeenCalledOnce())

    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7,
        prompt: { itemId: 'journal-prompt' }
      })
    ).resolves.toEqual({ cancelled: false })
    expect(claude.connections[0]?.calls.some((call) => call.subtype === 'interrupt')).toBe(false)

    commitGate.resolve()
    await answer
    await expect(answered.promise).resolves.toMatchObject({
      behavior: 'allow',
      toolUseID: 'tool-1'
    })
  })

  it('lets prompt cancellation win and waits for SDK abort cleanup', async () => {
    const interruptGate = deferred()
    const controller = new AbortController()
    const claude = fakeClaude({
      replayUuid: 'turn-1',
      routes: { interrupt: () => interruptGate.promise }
    })
    const adapter = await acquired(claude)
    await startTurn(adapter)
    const connection = claude.connections[0]
    if (!connection) {
      throw new Error('expected Claude connection')
    }
    const answered = invokeCanUseTool(connection, 'Bash', 'permission-1', 'tool-1', {
      input: { command: 'git status' },
      signal: controller.signal
    })
    adapter.bindPromptItemId('session-1', 'journal-prompt', 'permission-1')

    let cancellationSettled = false
    const cancellation = adapter
      .cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7,
        prompt: { itemId: 'journal-prompt' }
      })
      .finally(() => {
        cancellationSettled = true
      })
    await vi.waitFor(() => expect(claude.connections[0]?.calls.at(-1)?.subtype).toBe('interrupt'))
    const commit = vi.fn(async () => undefined)
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: 'journal-prompt',
        kind: 'approval',
        optionId: 'allow',
        fence: 7,
        commit
      })
    ).rejects.toThrow(/no longer waiting/)
    expect(commit).not.toHaveBeenCalled()

    interruptGate.resolve()
    await Promise.resolve()
    expect(cancellationSettled).toBe(false)
    expect(answered.settled()).toBe(false)
    controller.abort()
    await expect(cancellation).resolves.toEqual({ cancelled: true })
    await expect(answered.promise).resolves.toBeNull()
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: 'journal-prompt',
        kind: 'approval',
        optionId: 'allow',
        fence: 7,
        commit
      })
    ).rejects.toThrow(/no longer waiting/)
    expect(controller.signal.aborted).toBe(true)
    expect(commit).not.toHaveBeenCalled()
  })

  it('cancels an owned prompt after another dispatch queues behind its turn', async () => {
    const controller = new AbortController()
    let queuedUuid = ''
    const claude = fakeClaude({
      replayUuids: ['turn-1', null],
      capabilities: ['interrupt_cancel_queued_v1'],
      routes: {
        interrupt: () => {
          controller.abort()
          return { still_queued: [], cancelled: [queuedUuid] }
        }
      }
    })
    const lateSettlements: unknown[] = []
    const adapter = await acquired(claude, {}, [], (settlement) => lateSettlements.push(settlement))
    await startTurn(adapter)
    const connection = claude.connections[0]
    if (!connection) {
      throw new Error('expected Claude connection')
    }
    const answered = invokeCanUseTool(connection, 'Bash', 'permission-queued', 'tool-queued', {
      input: { command: 'git status' },
      signal: controller.signal
    })
    adapter.bindPromptItemId('session-1', 'journal-prompt', 'permission-queued')
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'queued-message',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toEqual({ state: 'admitted' })
    const sentUuid = connection.sent.at(-1)?.uuid
    if (typeof sentUuid !== 'string') {
      throw new Error('expected queued dispatch uuid')
    }
    queuedUuid = sentUuid

    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7,
        prompt: { itemId: 'journal-prompt' }
      })
    ).resolves.toEqual({ cancelled: true })
    await expect(answered.promise).resolves.toBeNull()
    expect(connection.calls).toContainEqual({
      subtype: 'interrupt',
      params: { cancelQueued: true }
    })
    expect(lateSettlements).toContainEqual({
      sessionId: 'session-1',
      clientMessageId: 'queued-message',
      state: 'rejected',
      reason: 'provider_cancelled_before_start'
    })
  })

  it('does not interrupt a queued turn when the CLI cannot cancel queued messages', async () => {
    const claude = fakeClaude({ replayUuids: ['turn-1', null] })
    const adapter = await acquired(claude)
    await startTurn(adapter)
    const connection = claude.connections[0]
    if (!connection) {
      throw new Error('expected Claude connection')
    }
    const controller = new AbortController()
    const answered = invokeCanUseTool(connection, 'Bash', 'permission-legacy', 'tool-legacy', {
      input: { command: 'git status' },
      signal: controller.signal
    })
    adapter.bindPromptItemId('session-1', 'journal-prompt', 'permission-legacy')
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'queued-message',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toEqual({ state: 'admitted' })

    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7,
        prompt: { itemId: 'journal-prompt' }
      })
    ).resolves.toEqual({ cancelled: false })
    expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
    controller.abort()
    await expect(answered.promise).resolves.toBeNull()
  })

  it('does not interrupt a newer active turn through a stale prompt callback', async () => {
    const claude = fakeClaude({ replayUuids: ['turn-1', 'turn-2'] })
    const adapter = await acquired(claude)
    await startTurn(adapter)
    const connection = claude.connections[0]
    if (!connection) {
      throw new Error('expected Claude connection')
    }
    const controller = new AbortController()
    const answered = invokeCanUseTool(connection, 'Bash', 'permission-stale', 'tool-stale', {
      input: { command: 'git status' },
      signal: controller.signal
    })
    adapter.bindPromptItemId('session-1', 'journal-prompt', 'permission-stale')
    await startTurn(adapter, 'turn-2')

    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7,
        prompt: { itemId: 'journal-prompt' }
      })
    ).resolves.toEqual({ cancelled: false })
    expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
    expect(answered.settled()).toBe(false)
    controller.abort()
    await expect(answered.promise).resolves.toBeNull()
  })

  it('drops resolved prompt bodies instead of retaining them for the session lifetime', () => {
    const prompts = new ClaudeJournalPrompts({ sink: lifecycleRecorder().sink })

    for (let index = 0; index < 128; index += 1) {
      const promptKey = `resolved-${index}`
      prompts.handle({
        type: 'prompt',
        sessionId: 'session-1',
        prompt: {
          requestId: promptKey,
          promptKey,
          toolUseId: `tool-${index}`,
          toolName: 'Bash',
          kind: 'approval',
          input: { command: 'git status' },
          suggestions: [],
          questionIds: [],
          answers: new Map(),
          settle: vi.fn()
        }
      })
      prompts.resolve(promptKey)
    }

    expect(prompts.size).toBe(0)
  })

  it('releases the callback claim after a failed interrupt', async () => {
    const claude = fakeClaude({
      replayUuid: 'turn-1',
      routes: {
        interrupt: () => {
          throw new ClaudeControlRequestError('interrupt', 'not running')
        }
      }
    })
    const adapter = await acquired(claude)
    await startTurn(adapter)
    const connection = claude.connections[0]
    if (!connection) {
      throw new Error('expected Claude connection')
    }
    const answered = invokeCanUseTool(connection, 'Bash', 'permission-1', 'tool-1', {
      input: { command: 'git status' }
    })
    adapter.bindPromptItemId('session-1', 'journal-prompt', 'permission-1')

    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7,
        prompt: { itemId: 'journal-prompt' }
      })
    ).resolves.toEqual({ cancelled: false })
    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'journal-prompt',
      kind: 'approval',
      optionId: 'allow',
      fence: 7,
      commit: async () => undefined
    })
    await expect(answered.promise).resolves.toMatchObject({
      behavior: 'allow',
      toolUseID: 'tool-1'
    })
  })

  it('enqueues terminal prompt state before a confirmed cancellation resolves', async () => {
    const controller = new AbortController()
    const claude = fakeClaude({
      replayUuid: 'turn-1',
      routes: { interrupt: () => controller.abort() }
    })
    const recorded = lifecycleRecorder()
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: recorded.sink
    })
    await startTurn(adapter)
    const connection = claude.connections[0]
    if (!connection) {
      throw new Error('expected Claude connection')
    }
    const answered = invokeCanUseTool(connection, 'Bash', 'permission-1', 'tool-1', {
      input: { command: 'git status' },
      signal: controller.signal
    })
    adapter.bindPromptItemId('session-1', 'journal-prompt', 'permission-1')
    const promptItemId = [...recorded.bodies].find(([, body]) => body.kind === 'approval')?.[0]

    const cancellation = adapter
      .cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7,
        prompt: { itemId: 'journal-prompt' }
      })
      .then((result) => {
        recorded.order.push('resolved')
        return result
      })

    await expect(cancellation).resolves.toEqual({ cancelled: true })
    await expect(answered.promise).resolves.toBeNull()
    if (!promptItemId) {
      throw new Error('expected a recorded prompt item')
    }
    expect(recorded.order).toEqual(['prompt-lifecycle', 'resolved'])
    expect(
      [...recorded.bodies.values()].some(
        (body) =>
          (body.kind === 'approval' || body.kind === 'question') &&
          body.resolution.state === 'pending'
      )
    ).toBe(false)
    expect(recorded.bodies.get(promptItemId)).toMatchObject({
      resolution: { state: 'cancelled' }
    })
    expect(
      [...recorded.bodies.values()].some(
        (body) => readAgentJournalTurn(body)?.state === 'interrupted'
      )
    ).toBe(false)

    connection.handlers.onMessage?.({
      type: 'result',
      subtype: 'error_during_execution',
      uuid: 'result-1',
      session_id: PROVIDER_SESSION_ID,
      is_error: true,
      terminal_reason: 'aborted_tools',
      errors: [],
      duration_ms: 654
    })
    expect([...recorded.bodies.values()].find((body) => readAgentJournalTurn(body))).toMatchObject({
      state: 'interrupted',
      durationMs: 654
    })

    connection.handlers.onMessage?.({
      type: 'result',
      subtype: 'success',
      uuid: 'result-duplicate',
      session_id: PROVIDER_SESSION_ID,
      is_error: false,
      terminal_reason: 'completed',
      duration_ms: 999
    })
    expect([...recorded.bodies.values()].find((body) => readAgentJournalTurn(body))).toMatchObject({
      state: 'interrupted',
      durationMs: 654
    })

    expect(controller.signal.aborted).toBe(true)
    expect(recorded.tombstones).toHaveLength(0)
  })

  it('does not synthesize terminal lifecycle for ordinary Stop', async () => {
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(fakeClaude({ replayUuid: 'turn-1' }), {}, events)
    await startTurn(adapter)

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 7 })
    ).resolves.toEqual({ cancelled: true })
    expect(events.some((event) => event.type === 'prompt-cancelled')).toBe(false)
    expect(
      events.some((event) => event.type === 'message' && event.message.type === 'result')
    ).toBe(false)
  })

  it('does not report success or release the claim when prompt lifecycle admission fails', async () => {
    const controller = new AbortController()
    const claude = fakeClaude({
      replayUuid: 'turn-1',
      routes: { interrupt: () => controller.abort() }
    })
    const recorded = lifecycleRecorder(false)
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: recorded.sink
    })
    await startTurn(adapter)
    const connection = claude.connections[0]
    if (!connection) {
      throw new Error('expected Claude connection')
    }
    invokeCanUseTool(connection, 'Bash', 'permission-1', 'tool-1', {
      input: { command: 'git status' },
      signal: controller.signal
    })
    const promptItemId = [...recorded.bodies].find(([, body]) => body.kind === 'approval')?.[0]
    if (!promptItemId) {
      throw new Error('expected durable Claude prompt')
    }

    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7,
        prompt: { itemId: promptItemId }
      })
    ).rejects.toThrow(/lifecycle was not admitted/)
    const commit = vi.fn(async () => undefined)
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: promptItemId,
        kind: 'approval',
        optionId: 'allow',
        fence: 7,
        commit
      })
    ).rejects.toThrow(/no longer waiting/)
    expect(commit).not.toHaveBeenCalled()
  })

  it('checks the bound item, turn, fence, and current acquisition without callback revival', async () => {
    const claude = fakeClaude({ replayUuid: 'turn-1' })
    const adapter = await acquired(claude)
    await startTurn(adapter)
    const connection = claude.connections[0]
    if (!connection) {
      throw new Error('expected Claude connection')
    }
    const answered = invokeCanUseTool(connection, 'Bash', 'permission-1', 'tool-1', {
      input: { command: 'git status' }
    })
    adapter.bindPromptItemId('session-1', 'journal-prompt', 'permission-1')

    for (const input of [
      { turnId: 'turn-1', fence: 7, itemId: 'other-item' },
      { turnId: 'turn-2', fence: 7, itemId: 'journal-prompt' },
      { turnId: 'turn-1', fence: 6, itemId: 'journal-prompt' }
    ]) {
      await expect(
        adapter.cancelTurn({
          sessionId: 'session-1',
          turnId: input.turnId,
          fence: input.fence,
          prompt: { itemId: input.itemId }
        })
      ).resolves.toEqual({ cancelled: false })
    }
    expect(claude.connections[0]?.calls.some((call) => call.subtype === 'interrupt')).toBe(false)

    await adapter.acquire({ identity: identityFor(), fence: 8, spawnToken: 'spawn-10' })
    await expect(answered.promise).resolves.toBeNull()
    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 8,
        prompt: { itemId: 'journal-prompt' }
      })
    ).resolves.toEqual({ cancelled: false })
    const commit = vi.fn(async () => undefined)
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: 'journal-prompt',
        kind: 'approval',
        optionId: 'allow',
        fence: 8,
        commit
      })
    ).rejects.toThrow(/no longer waiting/)
    expect(commit).not.toHaveBeenCalled()
    expect(claude.connections[1]?.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
  })

  it('rejects a grouped prompt batch without partially revising its first row', () => {
    const tombstones: string[] = []
    const appendTombstone = vi.fn(
      (identity: Parameters<StructuredAgentSessionEventSink['appendTombstone']>[0]) => {
        tombstones.push(agentJournalItemKey(identity))
      }
    )
    let rowAdmission = 0
    const tryAppendTombstone = vi.fn(
      (identity: Parameters<StructuredAgentSessionEventSink['appendTombstone']>[0]) => {
        rowAdmission += 1
        if (rowAdmission === 2) {
          return { accepted: false as const, reason: 'backpressure' as const }
        }
        appendTombstone(identity)
        return { accepted: true as const }
      }
    )
    const tryAppendLifecycleBatch = vi.fn(
      (
        _settlementId: string,
        mutations: Parameters<
          NonNullable<StructuredAgentSessionEventSink['tryAppendLifecycleBatch']>
        >[1]
      ) => {
        expect(mutations[1]).toMatchObject({
          kind: 'item',
          body: { resolution: { state: 'cancelled' } }
        })
        return { accepted: false as const, reason: 'backpressure' as const }
      }
    )
    const prompts = new ClaudeJournalPrompts({
      sink: {
        appendItem: () => {},
        appendTombstone,
        tryAppendTombstone,
        tryAppendLifecycleBatch,
        publish: () => {}
      },
      questionItems: (input) => {
        const item = claudeQuestionItems(input)[0]
        return item
          ? [
              {
                ...item,
                identity: { provider: 'orca', clientMessageId: 'group:first' }
              },
              {
                ...item,
                identity: { provider: 'orca', clientMessageId: 'group:second' }
              }
            ]
          : []
      }
    })
    const prompt: ClaudePendingPrompt = {
      requestId: 'grouped-request',
      promptKey: 'grouped-request',
      toolUseId: 'tool-grouped',
      toolName: 'AskUserQuestion',
      kind: 'question',
      input: {
        questions: [
          { question: 'First?', options: [{ label: 'Yes' }] },
          { question: 'Second?', options: [{ label: 'No' }] }
        ]
      },
      suggestions: [],
      questionIds: ['First?', 'Second?'],
      answers: new Map(),
      settle: vi.fn()
    }
    prompts.handle({ type: 'prompt', sessionId: 'session-1', prompt })

    expect(prompts.cancel(prompt.promptKey)).toEqual({
      accepted: false,
      reason: 'backpressure'
    })
    expect(tryAppendLifecycleBatch).toHaveBeenCalledOnce()
    expect(tryAppendTombstone).not.toHaveBeenCalled()
    expect(tombstones).toEqual([])
  })

  it('keeps every backpressured prompt cancellation retry in its owned entry', () => {
    let backpressured = true
    let lifecycleAttempts = 0
    const prompts = new ClaudeJournalPrompts({
      sink: {
        appendItem: () => {},
        appendTombstone: () => {},
        publish: () => {},
        tryAppendLifecycleBatch: () => {
          lifecycleAttempts += 1
          return backpressured ? { accepted: false, reason: 'backpressure' } : { accepted: true }
        }
      }
    })
    const registerCancellation = (index: number): void => {
      const promptKey = `permission-${index}`
      const prompt: ClaudePendingPrompt = {
        requestId: promptKey,
        promptKey,
        toolUseId: `tool-${index}`,
        toolName: 'Bash',
        kind: 'approval',
        input: { command: 'git status' },
        suggestions: [],
        questionIds: [],
        answers: new Map(),
        settle: vi.fn()
      }
      prompts.handle({ type: 'prompt', sessionId: 'session-1', prompt })
      prompts.cancel(promptKey)
    }

    registerCancellation(0)
    prompts.cancel('permission-0')
    expect(prompts.pendingCancellationCount).toBe(1)
    for (let index = 1; index < 65; index += 1) {
      registerCancellation(index)
    }
    expect(prompts.pendingCancellationCount).toBe(65)

    backpressured = false
    const attemptsBeforeRecovery = lifecycleAttempts
    prompts.retryPendingCancellations()
    expect(lifecycleAttempts - attemptsBeforeRecovery).toBe(65)
    expect(prompts.pendingCancellationCount).toBe(0)
    expect(prompts.size).toBe(0)
    const attemptsAfterRecovery = lifecycleAttempts
    prompts.retryPendingCancellations()
    expect(lifecycleAttempts).toBe(attemptsAfterRecovery)

    backpressured = true
    registerCancellation(65)
    expect(prompts.pendingCancellationCount).toBe(1)
    prompts.resolve('permission-65')
    expect(prompts.pendingCancellationCount).toBe(0)
    registerCancellation(66)
    prompts.clear()
    expect(prompts.pendingCancellationCount).toBe(0)
    expect(prompts.size).toBe(0)
  })
})
