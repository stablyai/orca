import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { validateOrcadLiveCutoverTransition } from '../../../shared/orcad-live-cutover-transition'
import { assertOrcadMigrationManifestDigest } from '../../orcad/orcad-migration-manifest-digest'
import type { OrcadSourceCutoverContext } from './orcad-source-cutover-context'
import {
  findCutover,
  replaceCutover,
  requireSourceFence,
  assertSourceTargetIdentity,
  assertSourceCatalogUnchanged
} from './orcad-source-cutover-validation'

export function recordOrcadSourceLiveProgress(
  context: OrcadSourceCutoverContext,
  migrationId: string,
  expected: unknown,
  next: unknown
) {
  const current = findCutover(context.runtime.state, migrationId)
  if (
    !current ||
    serializeOrcadMigrationValue(current) !== serializeOrcadMigrationValue(expected)
  ) {
    throw new Error('orcad_live_cutover_progress_stale')
  }
  const parsed = validateOrcadLiveCutoverTransition(current, next)
  assertOrcadMigrationManifestDigest(parsed.manifest)
  assertSourceTargetIdentity(requireSourceFence(context.runtime.state, current), parsed.manifest)
  assertSourceCatalogUnchanged(context.projects, parsed.manifest)
  return structuredClone(replaceCutover(context, parsed))
}
