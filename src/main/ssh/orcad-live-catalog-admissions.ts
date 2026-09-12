import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { parseOrcadTerminalLayoutAdmission } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission'

export function groupOrcadLiveCatalogAdmissions(cutover: OrcadMigrationSourceCutover) {
  const bindings = cutover.liveTerminalBindings
  if (!bindings) {
    throw new Error('orcad_live_cutover_phase_observation_required')
  }
  const groups = new Map<string, typeof bindings>()
  for (const binding of bindings) {
    const { workspaceKey, tabId } = binding.surfaceBinding
    const key = JSON.stringify([workspaceKey, tabId])
    groups.set(key, [...(groups.get(key) ?? []), binding])
  }
  return [...groups.values()].map((group) =>
    parseOrcadTerminalLayoutAdmission({ version: 1, manifest: cutover.manifest, bindings: group })
  )
}
