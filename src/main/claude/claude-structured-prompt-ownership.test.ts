import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionEventSink
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { ClaudeJournalPrompts } from './claude-structured-journal-prompts'
import { claudeQuestionItems } from './claude-structured-prompt-items'
import type { ClaudePendingPrompt } from './claude-structured-prompt-replies'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  USER_MESSAGE,
  acquired,
  adapterFor,
  fakeClaude,
  identityFor
} from './claude-structured-session-test-support'
import { invokeCanUseTool } from './claude-can-use-tool-test-support'

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
      response: { kind: 'option', optionId: 'allow' },
      fence: 7,
      commit: async () => {
        expect(answered.settled()).toBe(false)
        commitStarted()
        await commitGate.promise
      }
    })
    await vi.waitFor(() => expect(commitStarted).toHaveBeenCalledOnce())

    commitGate.resolve()
    await answer
    await expect(answered.promise).resolves.toMatchObject({
      behavior: 'allow',
      toolUseID: 'tool-1'
    })
  })

  it("keeps the user's dismissal when Claude cancels the request while the host records it", async () => {
    const claude = fakeClaude({ replayUuid: 'turn-1' })
    const recorded = lifecycleRecorder()
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: recorded.sink
    })
    await startTurn(adapter)
    const request = new AbortController()
    invokeCanUseTool(claude.connections[0]!, 'AskUserQuestion', 'permission-1', 'tool-1', {
      input: { questions: [{ question: 'Which branch?', options: [{ label: 'main' }] }] },
      signal: request.signal
    })
    const [card] = [...recorded.bodies].find(([, body]) => body.kind === 'question') ?? []
    if (!card) {
      throw new Error('expected the question card')
    }

    const dismiss = adapter.dismissPrompt
    if (!dismiss) {
      throw new Error('expected Claude to dismiss a card')
    }
    await dismiss({
      sessionId: 'session-1',
      itemId: card,
      fence: 7,
      answer: false,
      // Claude's own cancel lands mid-commit, as an interrupt's can.
      commit: async () => request.abort()
    })

    expect(recorded.bodies.get(card)).toMatchObject({ resolution: { state: 'pending' } })
  })

  it('hands the card back when the host fails to record it, so a withdrawal still closes it', async () => {
    const claude = fakeClaude({ replayUuid: 'turn-1' })
    const recorded = lifecycleRecorder()
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: recorded.sink
    })
    await startTurn(adapter)
    const request = new AbortController()
    invokeCanUseTool(claude.connections[0]!, 'AskUserQuestion', 'permission-1', 'tool-1', {
      input: { questions: [{ question: 'Which branch?', options: [{ label: 'main' }] }] },
      signal: request.signal
    })
    const [card] = [...recorded.bodies].find(([, body]) => body.kind === 'question') ?? []
    const dismiss = adapter.dismissPrompt
    if (!card || !dismiss) {
      throw new Error('expected the question card and a dismissal')
    }

    await expect(
      dismiss({
        sessionId: 'session-1',
        itemId: card,
        fence: 7,
        answer: false,
        // Claude withdraws the request, then the host's record fails.
        commit: async () => {
          request.abort()
          throw new Error('journal write failed')
        }
      })
    ).rejects.toThrow('journal write failed')

    expect(recorded.bodies.get(card)).toMatchObject({ resolution: { state: 'cancelled' } })
  })

  it('drops resolved prompt bodies instead of retaining them for the session lifetime', () => {
    const prompts = new ClaudeJournalPrompts({
      sink: lifecycleRecorder().sink,
      turnScope: () => AGENT_JOURNAL_THREAD_SCOPE
    })

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
          settle: vi.fn()
        }
      })
      prompts.resolve(promptKey)
    }

    expect(prompts.size).toBe(0)
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
      },
      turnScope: () => AGENT_JOURNAL_THREAD_SCOPE
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
      },
      turnScope: () => AGENT_JOURNAL_THREAD_SCOPE
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
