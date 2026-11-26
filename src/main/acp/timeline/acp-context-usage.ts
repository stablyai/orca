import {
  MAX_CONTEXT_CURRENCY_CHARS,
  type AgentSessionContextUsage
} from '../../../shared/agent-session/conversation-context/agent-session-context-usage'
import type {
  ProviderTimelineEvent,
  ProviderTimelineJoin
} from '../../native-chat/agent-session-timeline/provider-timeline-event'

import type { AcpDialect } from '../acp-dialects/acp-dialect'
import type { SessionUpdate, UsageUpdate } from '../generated/acp-protocol.generated'

export class AcpContextTimeline {
  private window?: { tokens: number; capturedAt: number }

  // A getter, since the translator settles its dialect after its fields initialize.
  constructor(private readonly dialect: () => AcpDialect) {}

  models(models: unknown, at: number, join: ProviderTimelineJoin): ProviderTimelineEvent[] {
    const tokens = this.dialect().contextWindow?.(models)
    return tokens === undefined ? [] : this.update({ window: { tokens, capturedAt: at } }, join)
  }

  update(usage: AgentSessionContextUsage, join: ProviderTimelineJoin): ProviderTimelineEvent[] {
    this.window = usage.window ?? this.window
    return [
      {
        type: 'context.usage',
        usage: { ...usage, ...(this.window ? { window: this.window } : {}) },
        join
      }
    ]
  }

  /** Retain only context-window information from replayed history. */
  history(
    update: SessionUpdate | undefined,
    usage: AgentSessionContextUsage | undefined,
    at: number,
    join: ProviderTimelineJoin
  ): ProviderTimelineEvent[] {
    const events = usage ? this.update(usage, join) : []
    if (update?.sessionUpdate === 'usage_update') {
      events.push({
        type: 'context.usage',
        usage: acpWindowUsage(update, at, this.dialect()),
        join
      })
    }
    return events
  }
}

export function acpWindowUsage(
  update: UsageUpdate,
  at: number,
  dialect: AcpDialect
): AgentSessionContextUsage {
  return {
    window: { tokens: update.size, capturedAt: at },
    used: {
      kind: 'estimate',
      capturedAt: at,
      usage: {
        inputTokens: update.used,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0
      }
    },
    ...acpSessionCost(update, at),
    ...acpAutoCompaction(update, at, dialect)
  }
}

/** A point outside the window says nothing about where this session compacts. */
function acpAutoCompaction(
  update: UsageUpdate,
  at: number,
  dialect: AcpDialect
): Pick<AgentSessionContextUsage, 'autoCompaction'> {
  const tokens = dialect.autoCompactAtTokens?.(update)
  return tokens !== undefined && Number.isFinite(tokens) && tokens > 0 && tokens < update.size
    ? { autoCompaction: { autoCompactAtTokens: tokens, capturedAt: at } }
    : {}
}

/** Out-of-bounds costs are dropped, so a bad report cannot make the turn row inadmissible. */
function acpSessionCost(update: UsageUpdate, at: number): Pick<AgentSessionContextUsage, 'cost'> {
  const amount = update.cost?.amount
  const currency = update.cost?.currency.trim()
  return amount !== undefined &&
    Number.isFinite(amount) &&
    amount >= 0 &&
    currency &&
    currency.length <= MAX_CONTEXT_CURRENCY_CHARS
    ? { cost: { amount, currency, capturedAt: at } }
    : {}
}
