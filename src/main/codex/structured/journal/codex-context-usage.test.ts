import { describe, expect, it } from 'vitest'
import { readCodexContextUsage } from './codex-context-usage'
import { AgentSessionContextUsageSchema } from '../../../../shared/agent-session/conversation-context/agent-session-context-usage-schema'
import { selectStructuredAgentContextUsage } from '../../../../shared/agent-session/conversation-context/structured-agent-session-context-usage'
import { contextTokensFromUsage } from '../../../../shared/agent-session/conversation-context/agent-session-context-usage'

describe('Codex context and cumulative token accounting', () => {
  it('preserves session totals through the journal codec without counting cached input twice', () => {
    const facts = readCodexContextUsage(
      {
        tokenUsage: {
          total: { inputTokens: 320_000, cachedInputTokens: 240_000, outputTokens: 12_000 },
          last: { totalTokens: 64_000 },
          modelContextWindow: 256_000
        }
      },
      1
    )
    const decoded = AgentSessionContextUsageSchema.parse(JSON.parse(JSON.stringify(facts)))
    const summary = selectStructuredAgentContextUsage([], decoded)
    expect(summary).toMatchObject({
      usedTokens: 64_000,
      windowTokens: 256_000,
      percentage: 25,
      tokenUsage: {
        scope: 'session',
        counts: {
          inputTokens: 80_000,
          cacheReadInputTokens: 240_000,
          cacheCreationInputTokens: 0,
          outputTokens: 12_000
        }
      }
    })
    expect(contextTokensFromUsage(summary!.tokenUsage!.counts)).toBe(320_000)
  })

  it.each([
    { inputTokens: -1, outputTokens: 2 },
    { inputTokens: 10, cachedInputTokens: 11, outputTokens: 2 },
    { inputTokens: 10, outputTokens: Infinity },
    { inputTokens: '10', outputTokens: 2 }
  ])('keeps a valid context report when session counters are malformed: %j', (total) => {
    const facts = readCodexContextUsage(
      {
        tokenUsage: { total, last: { totalTokens: 50 }, modelContextWindow: 100 }
      },
      1
    )
    expect(facts?.used).toMatchObject({ kind: 'report', usedTokens: 50, percentage: 50 })
    expect(facts?.used).not.toHaveProperty('totalUsage')
  })
})
