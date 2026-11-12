import { z } from 'zod'
import type { AgentSessionModelOption } from '../../shared/agent-session/agent-session-wire'
import type { AcpOptionWrite } from '../acp/options/acp-structured-options'

const OmpNativeChatOptionsSchema = z.object({
  model: z.string().min(1).nullable(),
  models: z.array(
    z.object({
      id: z.string().min(1),
      priority: z.boolean(),
      family: z.enum(['openai', 'anthropic', 'google']).nullable()
    })
  ),
  serviceTier: z.string().min(1).nullable()
})

export type OmpNativeChatOptions = z.infer<typeof OmpNativeChatOptionsSchema>

export function readOmpNativeChatOptions(
  method: string,
  params: unknown
): OmpNativeChatOptions | undefined {
  if (method !== '_orca/omp/options') {
    return undefined
  }
  const result = OmpNativeChatOptionsSchema.safeParse(params)
  return result.success ? result.data : undefined
}

export function withOmpServiceTiers(
  models: AgentSessionModelOption[],
  report: OmpNativeChatOptions | undefined
): AgentSessionModelOption[] {
  if (!report) {
    return models
  }
  const supported = new Set(
    report.models.filter((model) => model.priority).map((model) => model.id)
  )
  return models.map((model) => ({
    ...model,
    serviceTiers: supported.has(model.id) ? [{ value: 'priority', label: 'Fast' }] : []
  }))
}

export function ompServiceTierWrite(
  report: OmpNativeChatOptions | undefined,
  modelId: string | undefined,
  value: string,
  command: ((value: string) => string) | undefined
): AcpOptionWrite | null {
  if (!report || !command) {
    return null
  }
  const model = report.models.find((entry) => entry.id === modelId)
  if (!model?.family) {
    return null
  }
  return value === 'default' || (value === 'priority' && model?.priority)
    ? { method: 'command', text: command(value) }
    : null
}

export function currentOmpServiceTier(
  report: OmpNativeChatOptions | undefined,
  modelId: string | undefined
): { serviceTier?: string } {
  return report?.model === modelId && report?.serviceTier ? { serviceTier: report.serviceTier } : {}
}
