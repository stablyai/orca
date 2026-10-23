import { z } from 'zod'
import type { AgentSessionContextUsage } from '../../shared/agent-session-context-usage'
import type {
  ProviderTimelineEvent,
  ProviderTimelineJoin
} from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import type { SessionUpdate, UsageUpdate } from './generated/acp-protocol.generated'

export class AcpContextTimeline {
  private window?: { tokens: number; capturedAt: number }

  models(
    models: unknown,
    at: number,
    dialect: AcpDialect,
    join: ProviderTimelineJoin
  ): ProviderTimelineEvent[] {
    const tokens = dialect.contextWindow?.(models)
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

  /** Replayed history is dropped except what it says about the context window. */
  history(
    update: SessionUpdate | undefined,
    usage: AgentSessionContextUsage | undefined,
    at: number,
    join: ProviderTimelineJoin
  ): ProviderTimelineEvent[] {
    const events = usage ? this.update(usage, join) : []
    if (update?.sessionUpdate === 'usage_update') {
      events.push({ type: 'context.usage', usage: acpWindowUsage(update, at), join })
    }
    return events
  }
}

export function acpWindowUsage(update: UsageUpdate, at: number): AgentSessionContextUsage {
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
    }
  }
}

export const acpNotificationEnvelopeSchema = z.looseObject({
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() }),
  _meta: z.looseObject({ isReplay: z.boolean().optional() }).nullish()
})
