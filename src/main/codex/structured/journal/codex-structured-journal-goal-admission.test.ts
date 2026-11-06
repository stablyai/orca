import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

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
})
