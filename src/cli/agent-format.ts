import type { RuntimeAgentLabel } from '../shared/runtime-types'

// Why: always echo the resolved paneKey AND terminal handle so a mis-target
// (e.g. the active-terminal fallback picked a different agent than intended)
// is immediately visible in human output, mirroring the JSON shape.
export function formatAgentLabel(result: { label: RuntimeAgentLabel }): string {
  const { label, paneKey, terminalHandle } = result.label
  const action = label ? `Set label "${label}"` : 'Cleared label'
  return `${action} for agent ${terminalHandle} (pane ${paneKey}).`
}
