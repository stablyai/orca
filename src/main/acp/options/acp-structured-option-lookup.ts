import type { SessionConfigOption } from '../generated/acp-protocol.generated'
import { acpEffortOption } from './acp-select-choices'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

function isSelect(option: SessionConfigOption): option is SelectOption {
  return option.type === 'select'
}

export function acpSelectById(
  options: readonly SessionConfigOption[],
  id: string | undefined
): SelectOption | null {
  if (!id) {
    return null
  }
  const option = options.find((entry) => entry.id === id)
  return option && isSelect(option) ? option : null
}

export function acpSelectByCategory(
  options: readonly SessionConfigOption[],
  category: string
): SelectOption | null {
  const option = options.find(
    (entry) => entry.category === category || (category === 'model' && entry.id === 'model')
  )
  return option && isSelect(option) ? option : null
}

export function acpReportedPermissionMode(
  currentMode: string | undefined,
  values: Readonly<Partial<Record<string, string>>> | undefined,
  appliedMode: string | null
): string | null {
  if (!values) {
    return appliedMode
  }
  return currentMode
    ? (Object.entries(values).find(([, value]) => value === currentMode)?.[0] ?? null)
    : null
}

export function acpCurrentModelAndEffort(
  options: readonly SessionConfigOption[],
  currentModelId: string | undefined
): Readonly<Record<string, string | undefined>> {
  return {
    model: (acpSelectByCategory(options, 'model')?.currentValue ?? currentModelId) || undefined,
    effort: acpEffortOption(options)?.currentValue
  }
}
