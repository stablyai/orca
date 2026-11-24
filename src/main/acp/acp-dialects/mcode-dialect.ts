import { acpSelectChoices } from '../options/acp-select-choices'
import type {
  SessionConfigOption,
  SessionConfigSelectOption
} from '../generated/acp-protocol.generated'
import type { AcpDialect } from './acp-dialect'
import { mcodeModelEfforts } from './mcode-model-catalog'
import {
  MCODE_MODEL_LABELS,
  mcodeSharedModelLabels,
  parseMcodeModelId
} from '../../../shared/agent-session/options/catalog-providers/agent-session-option-catalog-mcode'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

const isModelSelect = (option: SessionConfigOption): option is SelectOption =>
  option.type === 'select' && (option.category === 'model' || option.id === 'model')

const isThoughtLevel = (option: SessionConfigOption): boolean =>
  option.type === 'select' &&
  (option.category === 'thought_level' || option.id === 'thinkingEffort')

// Encoded id parts hold no colon, so the last `:v:` starts the variant.
const mcodeVariantBase = (value: string) => value.replace(/:v:[^:]*$/, '')

/** mcode lists a model with a thinking switch as an off row beside its thinking row. */
function mcodePairedOffRows(
  rows: readonly SessionConfigSelectOption[]
): (value: string) => boolean {
  const listed = new Set(rows.map((row) => row.value))
  return (value) =>
    value.endsWith(':v:') &&
    listed.has(value) &&
    listed.has(`${mcodeVariantBase(value)}:v:thinking`)
}

/** Names a session-menu model choice canonically. */
function resolveMcodeModelName(choice: SessionConfigSelectOption, modelId: string): string {
  if (MCODE_MODEL_LABELS[modelId]) {
    return MCODE_MODEL_LABELS[modelId]
  }
  const baseName = choice.name.replace(/\s*\u00b7\s*thinking$/, '')
  return baseName.startsWith('MiniMax') ? baseName : `MiniMax ${baseName}`
}

/** One row per model: a switchable model's off row folds into its thinking row. */
function normalizeMcodeModelSelect(model: SelectOption): SelectOption {
  const rows = acpSelectChoices(model)
  const paired = mcodePairedOffRows(rows)
  const kept = rows.filter((row) => !paired(row.value))
  const refs = kept.map((row) => parseMcodeModelId(row.value))
  const names = kept.map((row, index) =>
    resolveMcodeModelName(row, refs[index]?.modelId ?? row.value)
  )
  const sharedNames = mcodeSharedModelLabels(names)
  const choices = kept.map((row, index) => {
    const name = names[index]!
    const provider = refs[index]?.providerId.replace(/^custom_provider:/, '')
    // The picker lists model names only, so mcode's own row description goes too.
    const { description: _description, ...rest } = row
    return { ...rest, name: provider && sharedNames.has(name) ? `${name} (${provider})` : name }
  })

  const current = paired(model.currentValue)
    ? `${mcodeVariantBase(model.currentValue)}:v:thinking`
    : model.currentValue
  return {
    ...model,
    currentValue: choices.some((row) => row.value === current)
      ? current
      : (choices[0]?.value ?? current),
    options: choices
  }
}

/** The on/off menu standing for a model's listed variant pair; null where the model lists no switch. */
function mcodeThinkingMenu(model: SelectOption): SelectOption | null {
  const paired = mcodePairedOffRows(acpSelectChoices(model))
  const offRow = `${mcodeVariantBase(model.currentValue)}:v:`
  if (!paired(model.currentValue) && !paired(offRow)) {
    return null
  }
  return {
    type: 'select',
    id: 'thinkingEffort',
    name: 'Thinking effort',
    description: 'Controls whether thinking is enabled for this model.',
    category: 'thought_level',
    currentValue: model.currentValue.endsWith(':v:') ? 'off' : 'on',
    options: [
      { value: 'off', name: 'Off' },
      { value: 'on', name: 'On' }
    ]
  }
}

/** Cleans mcode's session menus: canonical names, one row per model, and an on/off thinking menu
 *  where the model lists its switch but offers no effort menu of its own. */
export function normalizeMcodeConfigOptions(options: SessionConfigOption[]): SessionConfigOption[] {
  const model = options.find(isModelSelect)
  let hasThoughtLevel = false
  const normalized = options.map((option) => {
    if (isModelSelect(option)) {
      return normalizeMcodeModelSelect(option)
    }
    // Not a type guard: the model select above already narrowed `option` past every select.
    if (isThoughtLevel(option)) {
      hasThoughtLevel = true
    }
    return option
  })
  const thinking = model && !hasThoughtLevel ? mcodeThinkingMenu(model) : null
  return thinking ? [...normalized, thinking] : normalized
}

export const MCODE_DIALECT: AcpDialect = {
  // Without forms, mcode degrades questionnaires to single-select permission prompts.
  clientCapabilities: { elicitation: { form: {} } },
  compactCommand: '/compact',
  effortSelectsThinkingVariant: true,
  modelEfforts: mcodeModelEfforts,
  unlistedMenuModelEfforts: true,
  normalizeConfigOptions: normalizeMcodeConfigOptions
}
