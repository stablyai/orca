import {
  antigravityModelChoices,
  parseAntigravityModelRows
} from '../../shared/agent-session/options/model-catalog/antigravity-model-families'
import type { AgentSessionModelOption } from '../../shared/agent-session/options/model-catalog/agent-session-model-option'
import { ANTIGRAVITY_ACP_DIALECT } from '../acp/acp-dialects/antigravity-dialect'
import { acpModelMenuModels } from '../acp/options/acp-model-menu'

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
