// Grok's own model facts: the per-model effort menu it writes in each model's `_meta`, and the
// models it lists during `initialize` (or serves from `x.ai/models/list`) with no session.

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
// The menu Grok offers a model that supports effort but names none of its own.
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
  reasoningEfforts: z.array(z.unknown()).optional()
})
const modelsListReplySchema = z.looseObject({
  result: SessionModelStateSchema.nullish(),
  error: z.unknown().optional()
})

function capitalized(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/** One model's effort menu as Grok advertises it. Choice values are Grok's option ids — what its
 *  effort config option takes — not the canonical sampling value behind them. */
export function grokModelEfforts(model: Pick<ModelInfo, '_meta'>): {
  efforts: AgentSessionOptionChoice[]
  defaultEffort?: string
} {
  const meta = modelMetaSchema.safeParse(model._meta ?? {})
  if (!meta.success || meta.data.supportsReasoningEffort !== true) {
    return { efforts: [] }
  }
  const efforts: AgentSessionOptionChoice[] = []
  let defaultEffort: string | undefined
  for (const raw of meta.data.reasoningEfforts ?? []) {
    const entry = effortEntrySchema.safeParse(raw)
    if (!entry.success) {
      continue
    }
    if (typeof entry.data === 'string') {
      efforts.push({ value: entry.data, label: EFFORT_LABELS[entry.data] ?? entry.data })
      continue
    }
    const id = entry.data.id ?? entry.data.value
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
    return {
      efforts: BUILT_IN_EFFORTS.map((value) => ({ value, label: EFFORT_LABELS[value] ?? value }))
    }
  }
  return { efforts, ...(defaultEffort ? { defaultEffort } : {}) }
}

/** Names no default: a session's own model can differ from the `currentModelId` computed without
 *  one (Grok resolves its default from remote config too), so a no-pick chat reports it instead. */
export function grokModelCatalogFromState(state: SessionModelState): AgentSessionModelOption[] {
  return state.availableModels.map((model) => ({
    id: model.modelId,
    label: model.name,
    ...(model.description ? { description: model.description } : {}),
    isDefault: false,
    ...grokModelEfforts(model)
  }))
}

/** The models `initialize` computed, else `x.ai/models/list`; neither creates a session. */
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
