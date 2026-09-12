import type { StoreRuntimeState } from './store-runtime-state'
import { inspectOrcadLiveRetirementProfileEvidence } from '../migrating-orcad-catalog/orcad-live-retirement-profile-state'

/** Main-only evidence; never expose the retained record through IPC. */
export function requireOrcadRetirementRendererEvidence(
  runtime: Pick<
    StoreRuntimeState,
    'state' | 'orcadRetirementSessionPublication' | 'orcadLiveCompletionDurability'
  >,
  migrationId: string
) {
  const records = runtime.orcadRetirementSessionPublication
    .installedRecords(runtime.state)
    .filter((record) => record.release.cutover.manifest.migrationId === migrationId)
  if (records.length !== 1) {
    throw new Error('orcad_live_renderer_plan_retirement_missing')
  }
  const evidence = inspectOrcadLiveRetirementProfileEvidence(runtime.state, records[0])
  if (
    evidence.state === 'conflict' ||
    !evidence.completedCutover ||
    !runtime.orcadLiveCompletionDurability.matches(evidence.completedCutover)
  ) {
    throw new Error('orcad_live_renderer_plan_completion_required')
  }
  return { record: records[0], completed: structuredClone(evidence.completedCutover) }
}
