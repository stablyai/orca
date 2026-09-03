import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'

export type AcpConfigOption = {
  id?: string
  name?: string
  category?: string | null
  currentValue?: unknown
  options?: { value?: string; name?: string; description?: string }[]
}

export type AcpConfigIndex = {
  values: Map<string, string>
  modelId: string | null
  effortId: string | null
  modeId: string | null
  result: AgentSessionOptionsResult
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  return value == null ? null : String(value)
}

function isModelOption(option: AcpConfigOption): boolean {
  return option.category === 'model' || option.id === 'model' || /model/i.test(option.id ?? '')
}

function isEffortOption(option: AcpConfigOption): boolean {
  return (
    option.category === 'thought_level' ||
    option.id === 'effort' ||
    /effort|thought/i.test(option.id ?? '')
  )
}

function isModeOption(option: AcpConfigOption): boolean {
  return option.category === 'mode' || option.id === 'mode' || /mode/i.test(option.id ?? '')
}

export function indexAcpConfigOptions(configOptions: AcpConfigOption[]): AcpConfigIndex {
  const values = new Map<string, string>()
  let model: AcpConfigOption | undefined
  let effort: AcpConfigOption | undefined
  let mode: AcpConfigOption | undefined
  for (const option of configOptions) {
    if (typeof option.id !== 'string') {
      continue
    }
    const current = stringValue(option.currentValue)
    if (current != null) {
      values.set(option.id, current)
    }
    if (!model && isModelOption(option)) {
      model = option
    } else if (!effort && isEffortOption(option)) {
      effort = option
    } else if (!mode && isModeOption(option)) {
      mode = option
    }
  }
  const modelChoices = (model?.options ?? [])
    .map((choice) => ({
      id: choice.value ?? '',
      label: choice.name ?? choice.value ?? '',
      ...(choice.description ? { description: choice.description } : {})
    }))
    .filter((choice) => choice.id.length > 0)
  const effortChoices = (effort?.options ?? [])
    .map((choice) => ({
      value: choice.value ?? '',
      label: choice.name ?? choice.value ?? '',
      ...(choice.description ? { description: choice.description } : {})
    }))
    .filter((choice) => choice.value.length > 0)
  const currentModel =
    (model?.id ? values.get(model.id) : undefined) ??
    modelChoices[0]?.id ??
    values.get('model') ??
    ''
  const currentEffort = effort?.id ? values.get(effort.id) : values.get('effort')
  const models =
    modelChoices.length > 0
      ? modelChoices.map((choice) => ({
          id: choice.id,
          label: choice.label,
          ...(choice.description ? { description: choice.description } : {}),
          isDefault: choice.id === currentModel,
          ...(effortChoices.length > 0
            ? { defaultEffort: currentEffort ?? effortChoices[0]?.value, efforts: effortChoices }
            : { efforts: [] as AgentSessionOptionsResult['models'][number]['efforts'] })
        }))
      : currentModel
        ? [
            {
              id: currentModel,
              label: currentModel,
              isDefault: true,
              ...(effortChoices.length > 0
                ? {
                    defaultEffort: currentEffort ?? effortChoices[0]?.value,
                    efforts: effortChoices
                  }
                : { efforts: [] })
            }
          ]
        : []
  return {
    values,
    modelId: model?.id ?? (values.has('model') ? 'model' : null),
    effortId: effort?.id ?? null,
    modeId: mode?.id ?? null,
    result: {
      models,
      current: {
        model: currentModel,
        ...(currentEffort ? { effort: currentEffort } : {})
      }
    }
  }
}

export async function applyAcpSessionOption(input: {
  connection: {
    request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  }
  acpSessionId: string
  config: AcpConfigIndex
  key: string
  value: string
}): Promise<AcpConfigIndex> {
  const configId = configIdForOptionKey(input.config, input.key)
  if (input.key === 'mode') {
    await input.connection.request('session/set_mode', {
      sessionId: input.acpSessionId,
      modeId: input.value
    })
  } else {
    const updated = (await input.connection.request('session/set_config_option', {
      sessionId: input.acpSessionId,
      configId,
      value: input.value
    })) as { configOptions?: AcpConfigOption[] }
    if (updated?.configOptions) {
      input.config = indexAcpConfigOptions(updated.configOptions)
    }
  }
  input.config.values.set(configId, input.value)
  if (input.key === 'model') {
    input.config.result.current.model = input.value
  }
  if (input.key === 'effort') {
    input.config.result.current.effort = input.value
  }
  return input.config
}

export function configIdForOptionKey(index: AcpConfigIndex, key: string): string {
  if (key === 'model') {
    return index.modelId ?? 'model'
  }
  if (key === 'effort') {
    return index.effortId ?? 'effort'
  }
  if (key === 'mode') {
    return index.modeId ?? 'mode'
  }
  return key
}
