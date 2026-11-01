import { z } from 'zod'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { piRpcUsageSchema, type PiRpcModel } from './rpc-protocol'

const statsSchema = z.object({
  contextUsage: z
    .object({
      tokens: z.number().nonnegative().nullable().optional(),
      contextWindow: z.number().positive(),
      percent: z.number().nullable().optional()
    })
    .optional()
})

export class PiRpcContextUsage {
  private model?: PiRpcModel
  private compactedTokens?: number

  compacting(): ProviderTimelineEvent[] {
    this.compactedTokens = undefined
    return [{ type: 'context.usage', usage: { used: { kind: 'unknown', capturedAt: Date.now() } } }]
  }

  compacted(result: unknown): void {
    const parsed = z.object({ estimatedTokensAfter: z.number().nonnegative() }).safeParse(result)
    this.compactedTokens = parsed.success ? parsed.data.estimatedTokensAfter : undefined
  }

  setModel(model: PiRpcModel | undefined, at: number): ProviderTimelineEvent[] {
    const changed = model?.id !== this.model?.id || model?.provider !== this.model?.provider
    this.model = model
    return model?.contextWindow && model.contextWindow > 0
      ? [
          {
            type: 'context.usage',
            usage: {
              window: { tokens: model.contextWindow, capturedAt: at },
              ...(changed ? { used: { kind: 'unknown' as const, capturedAt: at } } : {})
            }
          }
        ]
      : []
  }

  live(value: unknown, at: number): ProviderTimelineEvent[] {
    const usage = piRpcUsageSchema.safeParse(value)
    if (!usage.success || Object.values(usage.data).every((tokens) => tokens === 0)) {
      return []
    }
    this.compactedTokens = undefined
    return [
      {
        type: 'context.usage',
        usage: {
          used: {
            kind: 'estimate',
            usage: {
              inputTokens: usage.data.input,
              outputTokens: usage.data.output,
              cacheCreationInputTokens: usage.data.cacheWrite,
              cacheReadInputTokens: usage.data.cacheRead
            },
            capturedAt: at
          }
        }
      }
    ]
  }

  stats(value: unknown, at: number): ProviderTimelineEvent[] {
    const parsed = statsSchema.safeParse(value)
    const context = parsed.success ? parsed.data.contextUsage : undefined
    if (!context) {
      return []
    }
    return [
      {
        type: 'context.usage',
        usage: {
          window: { tokens: context.contextWindow, capturedAt: at },
          used:
            context.tokens == null
              ? this.compactedTokens === undefined
                ? { kind: 'unknown', capturedAt: at }
                : {
                    kind: 'estimate',
                    usage: {
                      inputTokens: this.compactedTokens,
                      outputTokens: 0,
                      cacheCreationInputTokens: 0,
                      cacheReadInputTokens: 0
                    },
                    capturedAt: at
                  }
              : {
                  kind: 'report',
                  model: this.model ? `${this.model.provider}/${this.model.id}` : 'unknown',
                  usedTokens: context.tokens,
                  windowTokens: context.contextWindow,
                  percentage: context.percent ?? (context.tokens / context.contextWindow) * 100,
                  categories: [],
                  capturedAt: at
                }
        }
      }
    ]
  }
}
