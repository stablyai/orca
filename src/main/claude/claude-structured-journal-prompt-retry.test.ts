import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudePendingPrompt } from './claude-structured-prompt-replies'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

function approval(promptKey: string): ClaudePendingPrompt {
  return {
    requestId: promptKey,
    promptKey,
    toolUseId: 'tool-retry',
    toolName: 'Bash',
    kind: 'approval',
    input: { command: 'git status' },
    suggestions: [],
    questionIds: [],
    answers: new Map(),
    settle: () => {}
  }
}

function transientBackpressureSink(
  refusedAt: 'append' | 'publish',
  persistent = false
): {
  sink: StructuredAgentSessionEventSink
  durableApproval: () => AgentJournalItemBody | undefined
  appendAttempts: () => number
  publishAttempts: () => number
  appliedSettlements: Set<string>
  release: () => void
} {
  const staged = new Map<string, AgentJournalItemBody>()
  const durable = new Map<string, AgentJournalItemBody>()
  const appliedSettlements = new Set<string>()
  let lifecycleAppendAttempts = 0
  let lifecyclePublishAttempts = 0
  let released = false

  const persist = (): void => {
    durable.clear()

    for (const [key, body] of staged) {
      durable.set(key, body)
    }
  }

  const applyItem = (identity: AgentJournalItemIdentity, body: AgentJournalItemBody): void => {
    staged.set(agentJournalItemKey(identity), body)
  }

  return {
    sink: {
      appendItem: applyItem,
      appendTombstone: (identity) => staged.delete(agentJournalItemKey(identity)),
      publish: persist,
      tryAppendLifecycleBatch: (settlementId, mutations) => {
        lifecycleAppendAttempts += 1

        if (refusedAt === 'append' && (persistent ? !released : lifecycleAppendAttempts === 1)) {
          return { accepted: false, reason: 'backpressure' }
        }

        if (!appliedSettlements.has(settlementId)) {
          for (const mutation of mutations) {
            if (mutation.kind === 'item') {
              applyItem(mutation.identity, mutation.body)
            } else {
              staged.delete(agentJournalItemKey(mutation.identity))
            }
          }

          appliedSettlements.add(settlementId)
        }

        return { accepted: true }
      },
      tryPublish: () => {
        lifecyclePublishAttempts += 1

        if (refusedAt === 'publish' && (persistent ? !released : lifecyclePublishAttempts === 1)) {
          return { accepted: false, reason: 'backpressure' }
        }

        persist()

        return { accepted: true }
      }
    },
    durableApproval: () => [...durable.values()].find((body) => body.kind === 'approval'),
    appendAttempts: () => lifecycleAppendAttempts,
    publishAttempts: () => lifecyclePublishAttempts,
    appliedSettlements,
    release: () => {
      released = true
    }
  }
}

function rootResult() {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'result',
      subtype: 'success',
      uuid: 'result-success',
      session_id: 'claude-session',
      parent_tool_use_id: null,
      is_error: false,
      duration_ms: 1
    }
  }
}

function streamDelta(index: number) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'stream_event',
      uuid: `stream-${index}`,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'x' }
      }
    }
  }
}

describe('Claude journal prompt cancellation retry', () => {
  it.each(['append', 'publish'] as const)(
    'retries after transient lifecycle %s backpressure',
    (refusedAt) => {
      const state = transientBackpressureSink(refusedAt)
      const translator = createClaudeJournalTranslator({ sink: state.sink })
      const prompt = approval('permission-retry')

      translator.handle({ type: 'prompt', sessionId: 'orca-session', prompt })
      translator.handle({
        type: 'prompt-cancelled',
        sessionId: 'orca-session',
        promptKey: prompt.promptKey
      })
      expect(state.durableApproval()).toMatchObject({ resolution: { state: 'pending' } })

      translator.handle(rootResult())
      expect(state.durableApproval()).toMatchObject({ resolution: { state: 'cancelled' } })
      expect(state.appendAttempts()).toBe(2)
      expect(state.publishAttempts()).toBe(refusedAt === 'publish' ? 2 : 1)
      expect(state.appliedSettlements).toEqual(new Set(['prompt-cancelled:permission-retry']))

      translator.handle(rootResult())
      expect(state.appendAttempts()).toBe(2)
      expect(state.publishAttempts()).toBe(refusedAt === 'publish' ? 2 : 1)
    }
  )

  it('keeps streaming frames off retry work and recovers at the next root result', () => {
    const state = transientBackpressureSink('append', true)
    const translator = createClaudeJournalTranslator({ sink: state.sink })
    const prompt = approval('permission-streaming')

    translator.handle({ type: 'prompt', sessionId: 'orca-session', prompt })
    translator.handle({
      type: 'prompt-cancelled',
      sessionId: 'orca-session',
      promptKey: prompt.promptKey
    })
    expect(state.appendAttempts()).toBe(1)

    for (let index = 0; index < 100; index += 1) {
      translator.handle(streamDelta(index))
    }

    expect(state.appendAttempts()).toBe(1)

    state.release()
    translator.handle(rootResult())
    expect(state.appendAttempts()).toBe(2)
    expect(state.durableApproval()).toMatchObject({ resolution: { state: 'cancelled' } })
  })
})
