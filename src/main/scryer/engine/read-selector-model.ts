import type { ScryModel } from './model'
import type { ScryerModelReadInput, ScryerModelReadResult } from './types'
import { selectOverview } from './read-selector-model-overview'
import { selectSubtree } from './read-selector-model-subtree'
import { invalidInput, type SelectorResult } from './read-selector-result'

function selectFull(model: ScryModel, layer: ScryerModelReadResult['layer']): ScryerModelReadResult {
  return {
    view: 'full',
    layer,
    version: model.version,
    nodeCount: model.nodes.length,
    linkCount: model.links.length,
    groupCount: model.groups.length,
    model
  }
}

export function selectModelRead(
  model: ScryModel,
  input: ScryerModelReadInput
): SelectorResult<ScryerModelReadResult> {
  const layer = input.layer ?? 'plan'
  const view = input.view ?? (input.node ? 'subtree' : 'overview')
  if (view === 'subtree' && !input.node) {
    return invalidInput('node', 'subtree reads require node')
  }
  if ((view === 'overview' || view === 'full') && input.node) {
    return invalidInput('node', `${view} reads do not accept node`)
  }
  if (view === 'overview') {
    return { ok: true, result: selectOverview(model, layer) }
  }
  if (view === 'full') {
    return { ok: true, result: selectFull(model, layer) }
  }
  return selectSubtree(model, layer, input.node!)
}
