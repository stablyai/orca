import type { PersistedState } from '../../../shared/persisted-state-types'
import { parseOrcadMigrationSourceCutover } from '../../../shared/orcad-migration-source-cutover'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import type { TerminalScrollbackSnapshotStorage } from '../../terminal-scrollback-snapshots'
import { assertOrcadMigrationManifestDigest } from '../../orcad/orcad-migration-manifest-digest'
import type { bindOutgoingOrcadCatalogSource } from '../../ssh/orcad-outgoing-catalog-source'
import { mergeProjectHostSetupCompatibilityState } from '../tracking-repos/project-host-compatibility'
import { retireOrcadSourceCatalogState } from './orcad-source-cutover-retirement'
import { retireOrcadMigrationSourceDormantState } from './orcad-source-dormant-retirement'
import {
  assertSourceCatalogRetired,
  assertSourceCatalogUnchanged,
  assertSourceDependenciesAbsent,
  assertSourceDependenciesRetired,
  assertSourceTargetIdentity,
  findCutover,
  requireSourceFence
} from './orcad-source-cutover-validation'

/** Candidate only: caller must persist rollback/completion evidence before installing any state. */
export function buildOrcadLiveSourceRetirementCandidate(options: {
  state: PersistedState
  cutover: unknown
  sourceAdmission: Pick<
    ReturnType<typeof bindOutgoingOrcadCatalogSource>,
    'assertBindings' | 'projectSourceState' | 'assertCurrent'
  >
  storage?: TerminalScrollbackSnapshotStorage
  sourceCatalog?: Parameters<typeof assertSourceCatalogUnchanged>[0]
}): PersistedState {
  const cutover = parseOrcadMigrationSourceCutover(options.cutover)
  if (cutover.version !== 2 || cutover.phase !== 'destination-committed') {
    throw new Error('orcad_live_source_retirement_commit_required')
  }
  const { manifest } = cutover
  assertOrcadMigrationManifestDigest(manifest)
  options.sourceAdmission.assertBindings(cutover.liveTerminalBindings)
  const before = serializeOrcadMigrationValue(options.state)
  const state = structuredClone(options.state)
  if (
    serializeOrcadMigrationValue(findCutover(state, manifest.migrationId)) !==
    serializeOrcadMigrationValue(cutover)
  ) {
    throw new Error('orcad_live_cutover_progress_stale')
  }
  assertSourceTargetIdentity(requireSourceFence(state, cutover), manifest)
  assertSourceCatalogUnchanged(
    options.sourceCatalog ?? {
      getRepos: () => state.repos,
      getProjectGroups: () => state.projectGroups,
      getFolderWorkspaces: () => state.folderWorkspaces
    },
    manifest
  )
  const candidate = options.sourceAdmission.projectSourceState(
    state,
    manifest.source,
    manifest.payload
  )
  const runtime = { state: candidate, terminalScrollbackSnapshotStorage: options.storage ?? {} }
  assertSourceDependenciesAbsent(runtime, manifest)
  retireOrcadMigrationSourceDormantState(candidate, manifest)
  retireOrcadSourceCatalogState(candidate, manifest)
  Object.assign(candidate, mergeProjectHostSetupCompatibilityState(candidate, candidate.repos))
  assertSourceCatalogRetired(candidate, manifest)
  assertSourceDependenciesRetired(runtime, manifest)
  options.sourceAdmission.assertCurrent()
  if (serializeOrcadMigrationValue(options.state) !== before) {
    throw new Error('orcad_live_source_retirement_state_changed')
  }
  return candidate
}
