import { z } from 'zod'
import type { AgentSessionModelOption } from '../../shared/agent-session/agent-session-wire'
import { traexRecord } from './traex-protocol'

const quotaSchema = z.looseObject({
  usage_percent: z.number().optional(),
  usagePercent: z.number().optional(),
  reset_time: z.number().nullish(),
  resetTime: z.number().nullish()
})

const modelSchema = z.looseObject({
  id: z.string(),
  model: z.string(),
  displayName: z.string(),
  modelProviderId: z.string().nullish(),
  inputModalities: z.array(z.string()).optional(),
  isDefault: z.boolean(),
  hidden: z.boolean(),
  defaultReasoningEffort: z.string().optional(),
  supportedReasoningEfforts: z.array(
    z.object({ reasoningEffort: z.string(), description: z.string() })
  ),
  businessMetadata: z
    .looseObject({
      load: z.looseObject({ load_percent: z.number() }).nullish(),
      is_internal_usage_limit: z.boolean().optional(),
      internal_usage: quotaSchema.nullish(),
      internal_daily_quota_key: z.string().nullish(),
      internal_daily_usage: quotaSchema.nullish()
    })
    .optional()
})

export type TraexModel = z.infer<typeof modelSchema>

function quotaDescription(name: 'Daily' | 'Weekly', value: unknown): string | null {
  const quota = quotaSchema.safeParse(value)
  if (!quota.success) {
    return null
  }
  const percent = quota.data.usagePercent ?? quota.data.usage_percent
  if (percent === undefined) {
    return null
  }
  const reset = quota.data.resetTime ?? quota.data.reset_time
  const resets =
    reset == null
      ? ''
      : `; resets ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(reset * 1000))}`
  return `${name} quota: ${100 - percent}% left (${percent}% used)${resets}.`
}

export function traexModelOptions(
  models: readonly TraexModel[],
  usage?: unknown
): AgentSessionModelOption[] {
  const quotas = traexRecord(usage)
  const daily = Array.isArray(quotas.dailyUsage) ? quotas.dailyUsage.map(traexRecord) : []
  return models
    .filter((model) => !model.hidden)
    .map((model) => {
      const metadata = model.businessMetadata
      const dailyQuota =
        daily.find((quota) => quota.quotaKey === metadata?.internal_daily_quota_key) ??
        metadata?.internal_daily_usage
      const weeklyQuota = metadata?.is_internal_usage_limit
        ? (quotas.usage ?? metadata.internal_usage)
        : null
      const description = [
        metadata?.load ? `Model load: ${metadata.load.load_percent}%.` : null,
        quotaDescription('Daily', dailyQuota),
        quotaDescription('Weekly', weeklyQuota)
      ]
        .filter(Boolean)
        .join(' ')
      return {
        id: model.id,
        resolvedModel: model.model,
        label: model.displayName,
        isDefault: model.isDefault,
        ...(description ? { description } : {}),
        ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
        efforts: model.supportedReasoningEfforts.map((effort) => ({
          value: effort.reasoningEffort,
          label: effort.reasoningEffort,
          description: effort.description
        }))
      }
    })
}

export async function readTraexModelCatalog(connection: {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>
}): Promise<{ native: TraexModel[]; models: AgentSessionModelOption[] }> {
  const native: TraexModel[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const result = traexRecord(await connection.request('model/list', cursor ? { cursor } : {}))
    if (!Array.isArray(result.data)) {
      throw new Error('TRAE CLI did not return a model catalog')
    }
    for (const value of result.data) {
      native.push(modelSchema.parse(value))
    }
    cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined
    if (cursor && cursors.has(cursor)) {
      throw new Error('TRAE CLI repeated a model catalog cursor')
    }
    if (cursor) {
      cursors.add(cursor)
    }
  } while (cursor)
  const usage = await connection.request('model/internalUsage/read').catch(() => undefined)
  return { native, models: traexModelOptions(native, usage) }
}
