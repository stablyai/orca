import { z } from 'zod'
import type { AgentSessionModelOption } from '../../shared/agent-session/agent-session-wire'
import type { AcpOptionWrite } from '../acp/options/acp-structured-options'

const OmpNativeChatOptionsSchema = z.object({
  models: z.array(
    z.object({
      id: z.string().min(1),
      serviceTiers: z.array(
        z.object({
          value: z.string().min(1),
          label: z.string().min(1),
          description: z.string().optional()
        })
      ),
      serviceTier: z.string().min(1).nullable()
    })
  )
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
  return models.map((model) => ({
    ...model,
    serviceTiers: report.models.find((entry) => entry.id === model.id)?.serviceTiers ?? []
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
  return report.models
    .find((entry) => entry.id === modelId)
    ?.serviceTiers.some((choice) => choice.value === value)
    ? { method: 'command', text: command(value) }
    : null
}

export function currentOmpServiceTier(
  report: OmpNativeChatOptions | undefined,
  modelId: string | undefined
): { serviceTier?: string } {
  const value = report?.models.find((entry) => entry.id === modelId)?.serviceTier
  return value ? { serviceTier: value } : {}
}
