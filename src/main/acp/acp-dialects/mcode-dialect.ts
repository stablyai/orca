import { acpSelectChoices } from '../options/acp-select-choices'
import type {
  SessionConfigOption,
  SessionConfigSelectOption
} from '../generated/acp-protocol.generated'
import type { AcpDialect } from './acp-dialect'
import { mcodeModelEfforts } from './mcode-model-catalog'
import {
  MCODE_MODEL_DESCRIPTIONS,
  MCODE_MODEL_LABELS,
  mcodeModelDescription
} from '../../../shared/agent-session/options/agent-session-option-catalog-mcode'

/** Names a session-menu model choice canonically, keeping mcode's raw description when set. */
function resolveMcodeModelNameAndDescription(choice: SessionConfigSelectOption): {
  name: string
  description?: string
} {
  const rawId =
    choice.value
      .replace(/:v:[^:]*$/, '')
      .split(':')
      .pop() ?? choice.value
  if (MCODE_MODEL_LABELS[rawId]) {
    return {
      name: MCODE_MODEL_LABELS[rawId],
      description: MCODE_MODEL_DESCRIPTIONS[rawId]
    }
  }

  const baseName = choice.name.replace(/\s*\u00b7\s*thinking$/, '')
  const name = baseName.startsWith('MiniMax') ? baseName : `MiniMax ${baseName}`
  return { name, description: choice.description ?? mcodeModelDescription(rawId) }
}

/** Cleans mcode's session menus: thinking-variant models only, canonical names, an on/off
 *  thinking menu where the model is switchable but offers none. */
export function normalizeMcodeConfigOptions(options: SessionConfigOption[]): SessionConfigOption[] {
  const modelOption = options.find(
    (opt) => opt.type === 'select' && (opt.category === 'model' || opt.id === 'model')
  )
  const rawModelValue = modelOption?.type === 'select' ? modelOption.currentValue : ''
  const isOff = rawModelValue.endsWith(':v:')
  const isSwitchable = mcodeModelEfforts({ modelId: rawModelValue }).efforts.some(
    (choice) => choice.value === 'off'
  )

  let hasThoughtLevel = false

  const normalized = options.map((option) => {
    if (option.type === 'select' && (option.category === 'model' || option.id === 'model')) {
      const choices = acpSelectChoices(option)
      // Thinking variants only: an off/thinking pair collapses to its thinking row, and a lone
      // off variant (`:v:`) is dropped instead of surfacing a non-thinking model.
      const cleanChoices: SessionConfigSelectOption[] = choices
        .filter((choice) => !choice.value.endsWith(':v:'))
        .map((choice) => {
          const { name, description } = resolveMcodeModelNameAndDescription(choice)
          return {
            ...choice,
            name,
            ...(description ? { description } : {})
          }
        })

      const fallbackValue = cleanChoices[0]?.value ?? option.currentValue
      const currentValue =
        cleanChoices.find((c) => c.value === option.currentValue)?.value ??
        cleanChoices.find((c) => c.value === `${option.currentValue}thinking`)?.value ??
        fallbackValue

      return {
        ...option,
        currentValue,
        options: cleanChoices
      }
    }
    if (
      option.type === 'select' &&
      (option.category === 'thought_level' || option.id === 'thinkingEffort')
    ) {
      hasThoughtLevel = true
      const choices = acpSelectChoices(option).filter((choice) => choice.value !== 'default')
      const currentValue =
        option.currentValue === 'default' || !option.currentValue ? 'high' : option.currentValue
      return {
        ...option,
        currentValue,
        options: choices
      }
    }
    return option
  })

  if (!hasThoughtLevel && isSwitchable) {
    normalized.push({
      type: 'select',
      id: 'thinkingEffort',
      name: 'Thinking effort',
      description: 'Controls whether thinking is enabled for this model.',
      category: 'thought_level',
      currentValue: isOff ? 'off' : 'on',
      options: [
        { value: 'off', name: 'Off' },
        { value: 'on', name: 'On' }
      ]
    })
  }

  return normalized
}

export const MCODE_DIALECT: AcpDialect = {
  effortChangesModel: true,
  effortSelectsThinkingVariant: true,
  modelEfforts: mcodeModelEfforts,
  normalizeConfigOptions: normalizeMcodeConfigOptions
}
