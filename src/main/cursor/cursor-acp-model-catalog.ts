import { z } from 'zod'
import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../shared/agent-session/agent-session-wire'
import type { InitializeResponse } from '../acp/generated/acp-protocol.generated'

const choiceSchema = z.looseObject({
  value: z.string(),
  name: z.string().optional(),
  description: z.string().optional()
})
const configOptionSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  category: z.string().optional(),
  currentValue: z.string().optional(),
  options: z.array(choiceSchema).optional()
})
const availableModelsSchema = z.looseObject({
  models: z.array(
    z.looseObject({
      value: z.string(),
      name: z.string(),
      description: z.string().optional(),
      configOptions: z.array(configOptionSchema).optional()
    })
  )
})

type ConfigOption = z.infer<typeof configOptionSchema>

function isEffortOption(option: ConfigOption): boolean {
  const id = option.id.trim().toLowerCase()
  const name = (option.name ?? '').trim().toLowerCase()
  return (
    option.category === 'thought_level' ||
    id === 'reasoning' ||
    id === 'reasoning_effort' ||
    id === 'effort' ||
    id === 'thinking' ||
    name.includes('reasoning') ||
    name.includes('effort')
  )
}

function choices(option: ConfigOption | undefined): AgentSessionOptionChoice[] {
  return (option?.options ?? []).flatMap((choice) =>
    choice.value.length > 0
      ? [
          {
            value: choice.value,
            label: choice.name && choice.name.length > 0 ? choice.name : choice.value,
            ...(choice.description ? { description: choice.description } : {})
          }
        ]
      : []
  )
}

/** One row per base model. No effort menu means the model has no level to show. */
export function cursorModelsFromAvailableList(payload: unknown): AgentSessionModelOption[] {
  const parsed = availableModelsSchema.safeParse(payload)
  if (!parsed.success || parsed.data.models.length === 0) {
    throw new Error('cursor did not list its models')
  }
  return parsed.data.models.flatMap((model) => {
    if (model.value.length === 0 || model.name.length === 0) {
      return []
    }
    const options = model.configOptions ?? []
    const effort = choices(options.find(isEffortOption))
    const fast = options.find((option) => option.id === 'fast')
    return [
      {
        id: model.value,
        label: model.name,
        ...(model.description ? { description: model.description } : {}),
        isDefault: false,
        efforts: effort.length > 1 ? effort : [],
        // Null declares there is no level, so a session default cannot stand in for one.
        ...(effort.length > 1 ? {} : { declaredDefaultEffort: null }),
        ...(fast && choices(fast).length > 1 ? { supportsFastMode: true as const } : {})
      }
    ]
  })
}

export async function readCursorModelCatalog(
  _initialized: InitializeResponse,
  connection: { requestSessionFreeExtension(method: string, params: unknown): Promise<unknown> }
): Promise<AgentSessionModelOption[]> {
  return cursorModelsFromAvailableList(
    await connection.requestSessionFreeExtension('cursor/list_available_models', {})
  )
}
