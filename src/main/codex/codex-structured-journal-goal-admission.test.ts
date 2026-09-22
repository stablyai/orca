import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CodexJournalGoals } from './codex-structured-journal-goals'
import {
  createCodexJournalTranslator,
  MAX_CODEX_GENERIC_ROWS_PER_TURN
} from './codex-structured-journal-translation'
import { MAX_CODEX_GOAL_THREADS } from './codex-structured-journal-limits'

const THREAD = '01a08cc2-f96e-76d0-bb74-88b9bc0b03fc'

function goalFrame(goal: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    threadId: THREAD,
    turnId: 'turn-1',
    goal: {
      threadId: THREAD,
      objective: 'Keep the current scratch directory tidy.',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1789067988,
      updatedAt: 1789067988,
      ...goal
    }
  }
}

function texts(rows: readonly AgentJournalItemBody[]): string[] {
  return rows.map((row) => (row.kind === 'status' ? row.text : ''))
}

describe('codex goal lifecycle admission', () => {
  it.each(['append', 'publish'] as const)(
    'retries the same goal after rejected %s without losing or duplicating its row',
    (stage) => {
      let reject = true
      let successfulPublishes = 0
      const rows = new Map<string, AgentJournalItemBody>()
      const identities: string[] = []
      const lifecycleOptions: boolean[] = []
      const sink = {
        appendItem: () => {},
        appendTombstone: () => {},
        publish: () => {},
        tryAppendItem: (identity, body, options) => {
          if (stage === 'append' && reject) {
            return { accepted: false, reason: 'backpressure' } as const
          }
          const key = agentJournalItemKey(identity)
          identities.push(key)
          rows.set(key, body)
          lifecycleOptions.push(options?.lifecycle === true)
          return { accepted: true } as const
        },
        tryPublish: (options) => {
          if (stage === 'publish' && reject) {
            return { accepted: false, reason: 'backpressure' } as const
          }
          successfulPublishes += 1
          lifecycleOptions.push(options?.lifecycle === true)
          return { accepted: true } as const
        }
      } satisfies StructuredAgentSessionEventSink
      const translator = createCodexJournalTranslator({ sink })
      const event = {
        type: 'notification' as const,
        sessionId: 'session',
        threadId: THREAD,
        method: 'thread/goal/updated',
        params: goalFrame()
      }

      expect(translator.handle(event)).toEqual({ accepted: false, reason: 'backpressure' })
      reject = false
      expect(translator.handle(event)).toEqual({ accepted: true })

      expect(rows.size).toBe(1)
      expect(new Set(identities)).toHaveLength(1)
      expect(successfulPublishes).toBe(1)
      expect(lifecycleOptions.every(Boolean)).toBe(true)
      translator.dispose()
    }
  )

  it('does not let the generic-row cap permanently hide the first goal evidence', () => {
    const rows: AgentJournalItemBody[] = []
    const sink = {
      appendItem: (_identity: AgentJournalItemIdentity, body: AgentJournalItemBody) =>
        rows.push(body),
      appendTombstone: () => {},
      publish: () => {}
    } satisfies StructuredAgentSessionEventSink
    const translator = createCodexJournalTranslator({ sink })
    for (let index = 0; index < MAX_CODEX_GENERIC_ROWS_PER_TURN; index += 1) {
      translator.handle({
        type: 'notification',
        sessionId: 'session',
        threadId: THREAD,
        method: 'process/exited',
        params: { threadId: THREAD, turnId: 'turn-1', processId: `process-${index}` }
      })
    }

    translator.handle({
      type: 'notification',
      sessionId: 'session',
      threadId: THREAD,
      method: 'thread/goal/updated',
      params: goalFrame()
    })
    translator.handle({
      type: 'notification',
      sessionId: 'session',
      threadId: THREAD,
      method: 'thread/goal/updated',
      params: { ...goalFrame({ tokensUsed: 1 }), turnId: 'turn-2' }
    })

    expect(texts(rows).filter((text) => text.startsWith('Goal '))).toEqual([
      'Goal set: Keep the current scratch directory tidy.'
    ])
    translator.dispose()
  })

  it('keeps repeated lifecycle states distinct across status cycles and goal recreation', () => {
    const rows = new Map<string, AgentJournalItemBody>()
    const sink = {
      appendItem: (identity: AgentJournalItemIdentity, body: AgentJournalItemBody) =>
        rows.set(agentJournalItemKey(identity), body),
      appendTombstone: () => {},
      publish: () => {}
    } satisfies StructuredAgentSessionEventSink
    const goals = new CodexJournalGoals(sink)
    const update = (goal: Record<string, unknown> = {}) =>
      goals.handle({ threadId: THREAD, method: 'thread/goal/updated', params: goalFrame(goal) })
    const clear = () =>
      goals.handle({
        threadId: THREAD,
        method: 'thread/goal/cleared',
        params: { threadId: THREAD }
      })

    update()
    update({ status: 'paused' })
    update()
    clear()
    update()
    clear()
    clear()

    expect(texts([...rows.values()])).toEqual([
      'Goal set: Keep the current scratch directory tidy.',
      'Goal paused: Keep the current scratch directory tidy.',
      'Goal set: Keep the current scratch directory tidy.',
      'Goal cleared',
      'Goal set: Keep the current scratch directory tidy.',
      'Goal cleared'
    ])
    goals.dispose()
  })

  it('bounds thread state with LRU eviction while stable identities keep one history row', () => {
    const writes: string[] = []
    const rows = new Map<string, AgentJournalItemBody>()
    const sink = {
      appendItem: (identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
        const key = agentJournalItemKey(identity)
        writes.push(key)
        rows.set(key, body)
      },
      appendTombstone: () => {},
      publish: () => {}
    } satisfies StructuredAgentSessionEventSink
    const goals = new CodexJournalGoals(sink)
    const send = (threadId: string) =>
      goals.handle({ threadId, method: 'thread/goal/updated', params: goalFrame() })

    for (let index = 0; index < MAX_CODEX_GOAL_THREADS; index += 1) {
      send(`thread-${index}`)
    }
    const threadZeroIdentity = writes[0]
    const threadOneIdentity = writes[1]
    send('thread-0')
    send('thread-over-cap')
    expect(writes).toHaveLength(MAX_CODEX_GOAL_THREADS + 1)

    send('thread-1')
    expect(writes).toHaveLength(MAX_CODEX_GOAL_THREADS + 2)
    expect(writes.at(-1)).toBe(threadOneIdentity)
    expect(rows).toHaveLength(MAX_CODEX_GOAL_THREADS + 1)

    send('thread-0')
    expect(writes.at(-1)).toBe(threadOneIdentity)
    expect(writes.filter((identity) => identity === threadZeroIdentity)).toHaveLength(1)
    goals.dispose()
  })

  it('releases duplicate-suppression state on session clear and dispose', () => {
    const identities: string[] = []
    const sink = {
      appendItem: (identity: AgentJournalItemIdentity) => {
        identities.push(agentJournalItemKey(identity))
      },
      appendTombstone: () => {},
      publish: () => {}
    } satisfies StructuredAgentSessionEventSink
    const goals = new CodexJournalGoals(sink)
    const event = { threadId: THREAD, method: 'thread/goal/updated', params: goalFrame() }

    goals.handle(event)
    goals.handle(event)
    expect(identities).toHaveLength(1)

    goals.clear()
    goals.handle(event)
    expect(identities).toHaveLength(2)
    expect(new Set(identities)).toHaveLength(1)

    goals.dispose()
    goals.handle(event)
    expect(identities).toHaveLength(3)
    expect(new Set(identities)).toHaveLength(1)
  })
})
