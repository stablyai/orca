import {
  antigravityModelChoices,
  parseAntigravityModelRows
} from '../../shared/agent-session/options/model-catalog/antigravity-model-families'
import type { AgentSessionModelOption } from '../../shared/agent-session/options/model-catalog/agent-session-model-option'
import { ANTIGRAVITY_ACP_DIALECT } from '../acp/acp-dialects/antigravity-dialect'
import { acpModelMenuModels } from '../acp/options/acp-model-menu'
import { ANTIGRAVITY_LEVEL_SUFFIX } from '../../shared/agent-session/options/catalog-providers/agent-session-option-catalog-antigravity'

/** `agy models` prints "<id>\t<name>" per model and level; the menu is the one a chat builds. */
export function parseAgyModelListing(stdout: string): AgentSessionModelOption[] {
  const availableModels = parseAntigravityModelRows(stdout)
  const options = antigravityModelChoices(availableModels).map(({ id, label }) => ({
    value: id,
    name: label
  }))
  return acpModelMenuModels({
    dialect: ANTIGRAVITY_ACP_DIALECT,
    modelOption: { type: 'select', id: 'model', name: 'Model', currentValue: '', options },
    effortOption: null,
    state: { availableModels, currentModelId: '' },
    currentModel: undefined
  })
}

/** A level id as the family row and level a chat lists in its place; null when the listing names
 *  the id itself or the family does not offer that level and the requested effort. */
export function antigravityListedFamilySelection(
  options: Readonly<Record<string, string>>,
  listed: readonly Pick<AgentSessionModelOption, 'id' | 'efforts'>[]
): Record<string, string> | null {
  const [, family, level] = ANTIGRAVITY_LEVEL_SUFFIX.exec(options.model ?? '') ?? []
  const offered = listed.find((model) => model.id === family)?.efforts.map(({ value }) => value)
  const effort = options.effort ?? level
  return offered?.includes(level) &&
    offered.includes(effort) &&
    !listed.some((model) => model.id === options.model)
    ? { ...options, model: family, effort }
    : null
}
