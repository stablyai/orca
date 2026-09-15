import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { AGENT_SESSION_ID_MAX_LENGTH } from '../../shared/agent-session-wire'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CodexAppServerRequestError } from './codex-app-server-connection'
import {
  THREAD_ID,
  acquired,
  adapterFor,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'
import { CodexPromptRegistry } from './codex-structured-prompt-replies'
import type { CodexStructuredSessionEvent } from './codex-structured-session-state'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}

  const promise = new Promise<void>((finish) => {
    resolve = finish
  })

  return { promise, resolve }
}

function registerPrompt(
  adapter: Awaited<ReturnType<typeof acquired>>,
  codex: ReturnType<typeof fakeCodex>,
  itemId = 'journal-prompt',
  threadId = THREAD_ID,
  turnId = 'turn-1'
): void {
  codex.connections[0]?.handlers.onServerRequest?.({
    id: 11,
    method: 'item/commandExecution/requestApproval',
    params: { itemId: 'codex-item-1', threadId, turnId }
  })
  adapter.bindPromptItemId('session-1', itemId, 'codex-item-1', turnId, threadId)
}

function registerGroupedQuestionPrompt(
  codex: ReturnType<typeof fakeCodex>,
  threadId = THREAD_ID,
  turnId = 'turn-1'
): void {
  codex.connections[0]?.handlers.onServerRequest?.({
    id: 12,
    method: 'item/tool/requestUserInput',
    params: {
      itemId: 'codex-question-group',
      threadId,
      turnId,
      questions: [
        { id: 'first', question: 'First?', options: [{ label: 'yes' }] },
        { id: 'second', question: 'Second?', options: [{ label: 'no' }] }
      ]
    }
  })
}

function completeTurn(
  codex: ReturnType<typeof fakeCodex>,
  threadId: string,
  turnId = 'turn-1'
): void {
  codex.connections[0]?.handlers.onNotification?.('turn/completed', {
    threadId,
    turn: { id: turnId, status: 'interrupted' }
  })
}

function completionThreads(events: CodexStructuredSessionEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'notification' && event.method === 'turn/completed' ? [event.threadId] : []
  )
}

function lifecycleRecorder(
  acceptPromptCancellation = true,
  acceptTurnCompletion = true
): {
  sink: StructuredAgentSessionEventSink
  bodies: Map<string, AgentJournalItemBody>
  order: string[]
} {
  const bodies = new Map<string, AgentJournalItemBody>()
  const order: string[] = []
  const settlements = new Set<string>()

  const append = (identity: AgentJournalItemIdentity, body: AgentJournalItemBody): void => {
    bodies.set(agentJournalItemKey(identity), body)
  }

  const sink: StructuredAgentSessionEventSink = {
    appendItem: append,
    appendTombstone: (identity) => bodies.delete(agentJournalItemKey(identity)),
    publish: () => {},
    tryAppendItem: (identity, body, options) => {
      if (
        body.kind === 'approval' &&
        body.resolution.state === 'cancelled' &&
        options?.lifecycle === true
      ) {
        if (!acceptPromptCancellation) {
          return { accepted: false, reason: 'backpressure' }
        }

        order.push('prompt-lifecycle')
      }

      append(identity, body)

      return { accepted: true }
    },
    tryAppendLifecycleBatch: (settlementId, mutations) => {
      const cancelsPrompt = mutations.some(
        (mutation) =>
          mutation.kind === 'item' &&
          (mutation.body.kind === 'approval' || mutation.body.kind === 'question') &&
          mutation.body.resolution.state === 'cancelled'
      )

      if (cancelsPrompt && !acceptPromptCancellation) {
        return { accepted: false, reason: 'backpressure' }
      }

      if (settlementId.startsWith('turn-completed:') && !acceptTurnCompletion) {
        return { accepted: false, reason: 'backpressure' }
      }

      if (settlements.has(settlementId)) {
        return { accepted: true }
      }

      settlements.add(settlementId)

      for (const mutation of mutations) {
        if (mutation.kind === 'item') {
          append(mutation.identity, mutation.body)
        } else {
          bodies.delete(agentJournalItemKey(mutation.identity))
        }
      }

      if (cancelsPrompt) {
        order.push('prompt-lifecycle')
      }

      if (settlementId.startsWith('turn-completed:')) {
        order.push('turn-lifecycle')
      }

      return { accepted: true }
    },
    tryPublish: () => ({ accepted: true })
  }

  return { sink, bodies, order }
}

describe('Codex live prompt ownership', () => {
  it('lets an answer hold the callback claim through its journal commit', async () => {
    const codex = fakeCodex()
    const adapter = await acquired(codex)
    registerPrompt(adapter, codex)
    const commitGate = deferred()
    const commitStarted = vi.fn()

    const answer = adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'journal-prompt',
      kind: 'approval',
      optionId: 'accept',
      fence: 7,
      commit: async () => {
        expect(codex.connections[0]?.replies).toEqual([])
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
    expect(codex.connections[0]?.calls.some((call) => call.method === 'turn/interrupt')).toBe(false)

    commitGate.resolve()
    await answer
    expect(codex.connections[0]?.replies).toEqual([{ id: 11, result: { decision: 'accept' } }])
  })

  it('lets prompt cancellation win and retains its claim until terminal cleanup', async () => {
    const interruptGate = deferred()

    const codex = fakeCodex({
      'turn/interrupt': async () => {
        await interruptGate.promise
        completeTurn(codex, THREAD_ID)
      }
    })

    const adapter = await acquired(codex)
    registerPrompt(adapter, codex)

    const cancellation = adapter.cancelTurn({
      sessionId: 'session-1',
      turnId: 'turn-1',
      fence: 7,
      prompt: { itemId: 'journal-prompt' }
    })

    await vi.waitFor(() =>
      expect(codex.connections[0]?.calls.at(-1)?.method).toBe('turn/interrupt')
    )
    const commit = vi.fn(async () => undefined)
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: 'journal-prompt',
        kind: 'approval',
        optionId: 'accept',
        fence: 7,
        commit
      })
    ).rejects.toThrow(/no longer waiting/)
    expect(commit).not.toHaveBeenCalled()

    interruptGate.resolve()
    await expect(cancellation).resolves.toEqual({ cancelled: true })
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: 'journal-prompt',
        kind: 'approval',
        optionId: 'accept',
        fence: 7,
        commit
      })
    ).rejects.toThrow(/no longer waiting/)

    await adapter.closeSession('session-1')
    await adapter.acquire({ identity: identityFor('session-1'), fence: 8, spawnToken: 'spawn-10' })
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: 'journal-prompt',
        kind: 'approval',
        optionId: 'accept',
        fence: 8,
        commit
      })
    ).rejects.toThrow(/no longer waiting/)
    expect(commit).not.toHaveBeenCalled()
  })

  it('releases the callback claim after a failed interrupt', async () => {
    const codex = fakeCodex({
      'turn/interrupt': () => {
        throw new CodexAppServerRequestError('turn/interrupt', -32602, 'no such turn')
      }
    })

    const adapter = await acquired(codex)
    registerPrompt(adapter, codex)

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
      optionId: 'decline',
      fence: 7,
      commit: async () => undefined
    })
    expect(codex.connections[0]?.replies).toEqual([{ id: 11, result: { decision: 'decline' } }])
  })

  it('interrupts only the child provider turn when its controller turn differs', async () => {
    const codex = fakeCodex({
      'turn/interrupt': () => completeTurn(codex, 'thread-child', 'child-turn')
    })

    const terminateTurnProcesses = vi.fn(async () => true)
    const adapter = adapterFor(codex, {}, [], { terminateTurnProcesses })
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9'
    })
    registerPrompt(adapter, codex, 'child-prompt', 'thread-child', 'child-turn')

    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'root-turn',
        fence: 7,
        prompt: { itemId: 'child-prompt' }
      })
    ).resolves.toEqual({ cancelled: true })
    expect(codex.connections[0]?.calls.at(-1)).toEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-child', turnId: 'child-turn' }
    })
    expect(terminateTurnProcesses).not.toHaveBeenCalled()
    expect(codex.connections[0]?.closed).toBe(false)
  })

  it('keeps a wire-valid multibyte prompt turn id as the exact interrupt target', async () => {
    const promptTurnId = '界'.repeat(171)
    expect(promptTurnId.length).toBeLessThanOrEqual(AGENT_SESSION_ID_MAX_LENGTH)
    expect(Buffer.byteLength(promptTurnId, 'utf8')).toBeGreaterThan(AGENT_SESSION_ID_MAX_LENGTH)

    const codex = fakeCodex({
      'turn/interrupt': () => completeTurn(codex, 'thread-child', promptTurnId)
    })

    const adapter = await acquired(codex)
    registerPrompt(adapter, codex, 'child-prompt', 'thread-child', promptTurnId)

    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'root-turn',
        fence: 7,
        prompt: { itemId: 'child-prompt' }
      })
    ).resolves.toEqual({ cancelled: true })
    expect(codex.connections[0]?.calls.at(-1)).toEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-child', turnId: promptTurnId }
    })
  })

  it('settles a grouped prompt and its running turn before reporting cancellation', async () => {
    const codex = fakeCodex({
      'turn/interrupt': () => {
        codex.connections[0]?.handlers.onNotification?.('turn/completed', {
          threadId: THREAD_ID,
          turn: { id: 'turn-1', status: 'interrupted', durationMs: 456 }
        })
      }
    })

    const recorded = lifecycleRecorder()
    const adapter = adapterFor(codex)
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: recorded.sink
    })
    codex.connections[0]?.handlers.onNotification?.('turn/started', {
      threadId: THREAD_ID,
      turn: { id: 'turn-1' }
    })
    registerGroupedQuestionPrompt(codex)

    const questionItemIds = [...recorded.bodies]
      .filter(([, body]) => body.kind === 'question')
      .map(([itemId]) => itemId)

    expect(questionItemIds).toHaveLength(2)
    const selectedItemId = questionItemIds[0]
    const siblingItemId = questionItemIds[1]

    if (!selectedItemId || !siblingItemId) {
      throw new Error('expected two durable Codex questions')
    }

    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7,
        prompt: { itemId: selectedItemId }
      })
    ).resolves.toEqual({ cancelled: true })
    expect(
      questionItemIds.map((itemId) => {
        const body = recorded.bodies.get(itemId)

        return body?.kind === 'question' ? body.resolution.state : null
      })
    ).toEqual(['cancelled', 'cancelled'])
    expect([...recorded.bodies.values()].find((body) => readAgentJournalTurn(body))).toMatchObject({
      state: 'interrupted',
      durationMs: 456
    })

    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: siblingItemId,
        kind: 'question',
        optionId: 'no',
        fence: 7,
        commit: async () => undefined
      })
    ).rejects.toThrow(/no longer waiting/)
  })

  it('enqueues terminal prompt state before a confirmed cancellation resolves', async () => {
    const codex = fakeCodex({
      'turn/interrupt': () => {
        codex.connections[0]?.handlers.onNotification?.('turn/completed', {
          threadId: THREAD_ID,
          turn: { id: 'turn-1', status: 'interrupted', durationMs: 321 }
        })
      }
    })

    const recorded = lifecycleRecorder()
    const adapter = adapterFor(codex)
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: recorded.sink
    })
    registerPrompt(adapter, codex)
    const promptItemId = [...recorded.bodies].find(([, body]) => body.kind === 'approval')?.[0]

    if (!promptItemId) {
      throw new Error('expected durable Codex prompt')
    }

    const cancellation = adapter
      .cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7,
        prompt: { itemId: promptItemId }
      })
      .then((result) => {
        recorded.order.push('resolved')

        return result
      })

    await expect(cancellation).resolves.toEqual({ cancelled: true })
    expect(recorded.order).toEqual(['prompt-lifecycle', 'turn-lifecycle', 'resolved'])
    expect(
      [...recorded.bodies.values()].some(
        (body) => body.kind === 'approval' && body.resolution.state === 'cancelled'
      )
    ).toBe(true)
    expect([...recorded.bodies.values()].find((body) => readAgentJournalTurn(body))).toMatchObject({
      state: 'interrupted',
      durationMs: 321
    })

    codex.connections[0]?.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: 'turn-1', status: 'completed', durationMs: 999 }
    })
    expect([...recorded.bodies.values()].find((body) => readAgentJournalTurn(body))).toMatchObject({
      state: 'interrupted',
      durationMs: 321
    })
  })

  it('settles the prompt without inventing turn completion when none was observed', async () => {
    const codex = fakeCodex()
    const recorded = lifecycleRecorder()
    const adapter = adapterFor(codex)
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: recorded.sink
    })
    codex.connections[0]?.handlers.onNotification?.('turn/started', {
      threadId: THREAD_ID,
      turn: { id: 'turn-1' }
    })
    registerPrompt(adapter, codex)
    const promptItemId = [...recorded.bodies].find(([, body]) => body.kind === 'approval')?.[0]

    if (!promptItemId) {
      throw new Error('expected durable Codex prompt')
    }

    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7,
        prompt: { itemId: promptItemId }
      })
    ).resolves.toEqual({ cancelled: true })
    expect(recorded.bodies.get(promptItemId)).toMatchObject({
      kind: 'approval',
      resolution: { state: 'cancelled' }
    })
    expect([...recorded.bodies.values()].find((body) => readAgentJournalTurn(body))).toMatchObject({
      state: 'running'
    })

    codex.connections[0]?.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: 'turn-1', status: 'interrupted', durationMs: 777 }
    })
    expect([...recorded.bodies.values()].find((body) => readAgentJournalTurn(body))).toMatchObject({
      state: 'interrupted',
      durationMs: 777
    })

    const commit = vi.fn(async () => undefined)
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: promptItemId,
        kind: 'approval',
        optionId: 'accept',
        fence: 7,
        commit
      })
    ).rejects.toThrow(/no longer waiting/)
    expect(commit).not.toHaveBeenCalled()
  })

  it('does not synthesize terminal lifecycle for ordinary Stop', async () => {
    const events: CodexStructuredSessionEvent[] = []
    const adapter = await acquired(fakeCodex(), {}, events)

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 7 })
    ).resolves.toEqual({ cancelled: true })
    expect(completionThreads(events)).toEqual([])
  })

  it('does not report success or release the claim when prompt lifecycle admission fails', async () => {
    const codex = fakeCodex()
    const recorded = lifecycleRecorder(false)
    const adapter = adapterFor(codex)
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: recorded.sink
    })
    registerPrompt(adapter, codex)
    const promptItemId = [...recorded.bodies].find(([, body]) => body.kind === 'approval')?.[0]

    if (!promptItemId) {
      throw new Error('expected durable Codex prompt')
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
        optionId: 'accept',
        fence: 7,
        commit
      })
    ).rejects.toThrow(/no longer waiting/)
    expect(commit).not.toHaveBeenCalled()
  })

  it('does not report success when a deferred provider completion is backpressured', async () => {
    const recorded = lifecycleRecorder(true, false)

    const codex = fakeCodex({
      'turn/interrupt': () => {
        completeTurn(codex, THREAD_ID)
      }
    })

    const adapter = adapterFor(codex)
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: recorded.sink
    })
    registerPrompt(adapter, codex)
    const promptItemId = [...recorded.bodies].find(([, body]) => body.kind === 'approval')?.[0]

    if (!promptItemId) {
      throw new Error('expected durable Codex prompt')
    }

    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7,
        prompt: { itemId: promptItemId }
      })
    ).rejects.toThrow(/deferred turn completion lifecycle was not admitted/)
    const commit = vi.fn(async () => undefined)
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: promptItemId,
        kind: 'approval',
        optionId: 'accept',
        fence: 7,
        commit
      })
    ).rejects.toThrow(/no longer waiting/)
    expect(commit).not.toHaveBeenCalled()

    await adapter.closeSession('session-1')
  })

  it('defers only the matching thread and emits its terminal event before cancel resolves', async () => {
    const interruptGate = deferred()
    const events: CodexStructuredSessionEvent[] = []

    const codex = fakeCodex({
      'turn/interrupt': () => {
        completeTurn(codex, THREAD_ID)
        completeTurn(codex, 'thread-child')

        return interruptGate.promise
      }
    })

    const adapter = await acquired(codex, {}, events)
    registerPrompt(adapter, codex, 'child-prompt', 'thread-child')

    const cancellation = adapter
      .cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7,
        prompt: { itemId: 'child-prompt' }
      })
      .then((result) => {
        expect(completionThreads(events)).toEqual([THREAD_ID, 'thread-child'])

        return result
      })

    await vi.waitFor(() => expect(completionThreads(events)).toEqual([THREAD_ID]))

    interruptGate.resolve()
    await expect(cancellation).resolves.toEqual({ cancelled: true })
  })

  it('checks the bound item, fence, and current acquisition before interrupting', async () => {
    const codex = fakeCodex()
    const adapter = await acquired(codex)
    registerPrompt(adapter, codex)

    for (const input of [
      { turnId: 'turn-1', fence: 7, itemId: 'other-item' },
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

    expect(codex.connections[0]?.calls.some((call) => call.method === 'turn/interrupt')).toBe(false)

    await adapter.acquire({ identity: identityFor('session-1'), fence: 8, spawnToken: 'spawn-10' })
    await expect(
      adapter.cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 8,
        prompt: { itemId: 'journal-prompt' }
      })
    ).resolves.toEqual({ cancelled: false })
    expect(codex.connections[1]?.calls.some((call) => call.method === 'turn/interrupt')).toBe(false)
  })

  it('drops a retained cancellation claim with normal turn cleanup', () => {
    const prompts = new CodexPromptRegistry()
    prompts.register({
      id: 11,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'codex-item-1', threadId: THREAD_ID, turnId: 'turn-1' }
    })
    prompts.bindJournalItemId('journal-prompt', THREAD_ID, 'codex-item-1', 'turn-1')
    const claim = prompts.claimBound('journal-prompt')

    if (!claim) {
      throw new Error('expected prompt claim')
    }

    prompts.clearTurn(THREAD_ID, 'turn-1')

    expect(prompts.ownsClaim(claim)).toBe(false)
    expect(prompts.find('journal-prompt')).toBeNull()
  })
})
