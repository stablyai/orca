import { z } from 'zod'
import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../../shared/agent-session-wire'
import {
  SessionModelStateSchema,
  type InitializeResponse,
  type ModelInfo,
  type SessionModelState
} from '../generated/acp-protocol.generated'

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max'
}
// Fallback only for effort-capable models without an advertised menu.
const BUILT_IN_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const

const effortEntrySchema = z.union([
  z.string().min(1),
  z.looseObject({
    value: z.string().min(1),
    id: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    description: z.string().optional(),
    default: z.boolean().optional()
  })
])
const modelMetaSchema = z.looseObject({
  supportsReasoningEffort: z.boolean().optional(),
  reasoningEffort: z.unknown().optional(),
  reasoningEfforts: z.array(z.unknown()).optional()
})
const modelsListReplySchema = z.looseObject({
  result: SessionModelStateSchema.nullish(),
  error: z.unknown().optional()
})

function capitalized(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/** Effort choices use Grok's config option IDs, not underlying sampling values. */
export function grokModelEfforts(model: Pick<ModelInfo, '_meta'>): {
  efforts: AgentSessionOptionChoice[]
  defaultEffort?: string
  declaredDefaultEffort?: string | null
} {
  const meta = modelMetaSchema.safeParse(model._meta ?? {})
  if (!meta.success || meta.data.supportsReasoningEffort !== true) {
    return { efforts: [], declaredDefaultEffort: null }
  }
  const efforts: AgentSessionOptionChoice[] = []
  let defaultEffort: string | undefined
  let reportedDefaultEffort: string | undefined
  for (const raw of meta.data.reasoningEfforts ?? []) {
    const entry = effortEntrySchema.safeParse(raw)
    if (!entry.success) {
      continue
    }
    if (typeof entry.data === 'string') {
      efforts.push({ value: entry.data, label: EFFORT_LABELS[entry.data] ?? entry.data })
      if (entry.data === meta.data.reasoningEffort) {
        reportedDefaultEffort ??= entry.data
      }
      continue
    }
    const id = entry.data.id ?? entry.data.value
    if (entry.data.value === meta.data.reasoningEffort) {
      reportedDefaultEffort ??= id
    }
    const label =
      entry.data.label ??
      (entry.data.id ? capitalized(id) : (EFFORT_LABELS[entry.data.value] ?? entry.data.value))
    efforts.push({
      value: id,
      label,
      ...(entry.data.description ? { description: entry.data.description } : {})
    })
    if (entry.data.default === true) {
      defaultEffort ??= id
    }
  }
  if (efforts.length === 0) {
    efforts.push(
      ...BUILT_IN_EFFORTS.map((value) => ({ value, label: EFFORT_LABELS[value] ?? value }))
    )
    reportedDefaultEffort = efforts.find(({ value }) => value === meta.data.reasoningEffort)?.value
  }
  // An unmappable reported override leaves the default unknown, not the menu's recommendation.
  const declaredDefaultEffort =
    meta.data.reasoningEffort === undefined ? defaultEffort : reportedDefaultEffort
  return {
    efforts,
    ...(defaultEffort ? { defaultEffort } : {}),
    declaredDefaultEffort: declaredDefaultEffort ?? null
  }
}

/** Session-free currentModelId may differ from the model a chat runs; leave defaults to sessions. */
export function grokModelCatalogFromState(state: SessionModelState): AgentSessionModelOption[] {
  return state.availableModels.map((model) => ({
    id: model.modelId,
    label: model.name,
    ...(model.description ? { description: model.description } : {}),
    isDefault: false,
    ...grokModelEfforts(model)
  }))
}

export async function readGrokModelCatalog(
  initialized: InitializeResponse,
  connection: { requestSessionFreeExtension(method: string, params: unknown): Promise<unknown> }
): Promise<AgentSessionModelOption[]> {
  const fromInitialize = SessionModelStateSchema.safeParse(initialized._meta?.modelState)
  if (fromInitialize.success && fromInitialize.data.availableModels.length > 0) {
    return grokModelCatalogFromState(fromInitialize.data)
  }
  const reply = modelsListReplySchema.safeParse(
    await connection.requestSessionFreeExtension('x.ai/models/list', {})
  )
  if (
    !reply.success ||
    (reply.data.error !== undefined && reply.data.error !== null) ||
    !reply.data.result
  ) {
    throw new Error('grok did not list its models')
  }
  return grokModelCatalogFromState(reply.data.result)
}
