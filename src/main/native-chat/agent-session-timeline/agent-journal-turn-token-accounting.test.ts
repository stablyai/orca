import { expect, it } from 'vitest'
import { reviseAgentJournalTurnTokens } from './agent-journal-turn-token-accounting'
import {
  resolveAgentJournalTurnRowWrite,
  agentJournalTurnRowReservedBytes
} from './agent-journal-turn-row-revision'
import { AgentJournalItemBodySchema } from '../../../shared/agent-session/journal/agent-session-journal-schemas'
import type { AgentJournalTurnItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

it('counts only the pinned turn increments, deduplicates totals, and keeps reasoning within output', () => {
  const first = reviseAgentJournalTurnTokens(undefined, {
    provider: 'codex',
    total: {
      inputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 500,
      reasoningOutputTokens: 50,
      totalTokens: 1500
    },
    last: {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 40,
      reasoningOutputTokens: 10,
      totalTokens: 140
    }
  })
  const next = {
    provider: 'codex' as const,
    total: {
      inputTokens: 1100,
      cachedInputTokens: 220,
      outputTokens: 540,
      reasoningOutputTokens: 60,
      totalTokens: 1640
    },
    last: {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 40,
      reasoningOutputTokens: 10,
      totalTokens: 140
    }
  }
  const second = reviseAgentJournalTurnTokens(first, next)
  expect(second.tokens).toEqual({
    uncachedInput: 160,
    cacheReadInput: 40,
    cacheWriteInput: 0,
    output: 80,
    reasoningOutputSubset: 20
  })
  expect(reviseAgentJournalTurnTokens(second, next)).toEqual(second)
  expect(
    reviseAgentJournalTurnTokens(undefined, {
      provider: 'codex',
      total: next.total,
      last: { ...next.last, cachedInputTokens: 101 }
    }).tokens
  ).toBeNull()
})

it('replaces a provider result on replay rather than counting it again', () => {
  const result = {
    provider: 'claude' as const,
    tokens: {
      uncachedInput: 10,
      cacheReadInput: 100,
      cacheWriteInput: 20,
      output: 30,
      reasoningOutputSubset: null
    }
  }
  const first = reviseAgentJournalTurnTokens(undefined, result)
  expect(first.tokens).toEqual({
    uncachedInput: 10,
    cacheReadInput: 100,
    cacheWriteInput: 20,
    output: 30,
    reasoningOutputSubset: null
  })
  expect(reviseAgentJournalTurnTokens(first, result)).toEqual(first)
})

it('round-trips token accounting and preserves it across lifecycle and context revisions', () => {
  let body: AgentJournalTurnItem = {
    kind: 'turn',
    turnId: 'turn-1',
    state: 'running',
    startedAt: 10
  }
  const target = {
    identity: { provider: 'codex' as const, threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 }
  }
  const view = { itemBody: () => body, newestTurn: () => null, contextWindowHeld: () => false }
  const write = {
    tokenAccounting: {
      provider: 'claude' as const,
      tokens: {
        uncachedInput: 10,
        cacheReadInput: 100,
        cacheWriteInput: 20,
        output: 30,
        reasoningOutputSubset: null
      }
    }
  }
  const first = resolveAgentJournalTurnRowWrite(
    view,
    target,
    write,
    agentJournalTurnRowReservedBytes(target, write)
  )
  expect(first?.body.tokenAccounting?.tokens).toEqual({
    uncachedInput: 10,
    cacheReadInput: 100,
    cacheWriteInput: 20,
    output: 30,
    reasoningOutputSubset: null
  })
  if (!first) {
    throw new Error('expected revised turn')
  }
  body = first.body
  const next = {
    lifecycle: {
      kind: 'turn' as const,
      turnId: 'turn-1',
      state: 'completed' as const,
      outcome: 'success' as const,
      startedAt: 10,
      completedAt: 20
    },
    contextUsage: { window: { tokens: 200000, capturedAt: 20 } }
  }
  const ended = resolveAgentJournalTurnRowWrite(
    view,
    target,
    next,
    agentJournalTurnRowReservedBytes(target, next)
  )
  expect(ended?.body).toMatchObject({
    state: 'completed',
    tokenAccounting: first.body.tokenAccounting,
    contextUsage: next.contextUsage
  })
  const stored = AgentJournalItemBodySchema.parse(JSON.parse(JSON.stringify(ended?.body)))
  expect(stored).toEqual(ended?.body)
})
