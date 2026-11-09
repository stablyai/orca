import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionEventSink
} from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { ClaudeJournalPrompts } from './claude-structured-journal-prompts'
import type { ClaudePendingPrompt } from '../../claude-prompt-registry'
import {
  USER_MESSAGE,
  type acquired,
  adapterFor,
  fakeClaude,
  identityFor
} from '../claude-structured-session-test-support'
import { invokeCanUseTool } from '../../claude-can-use-tool-test-support'

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
        commit: async () => {
          request.abort()
          throw new Error('journal write failed')
        }
      })
    ).rejects.toThrow('journal write failed')

    expect(recorded.bodies.get(card)).toMatchObject({ resolution: { state: 'cancelled' } })
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
