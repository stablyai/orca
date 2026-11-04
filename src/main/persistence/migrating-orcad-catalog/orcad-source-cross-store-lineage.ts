import type { OrcadMigrationDormantCrossStoreLineage } from '../../../shared/orcad-migration/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { isCrossStoreWorkspaceLineage } from '../../../shared/worktree/cross-store-lineage-records'
import { compareKeys } from './orcad-source-key-order'
import { uniqueDestinationRows } from './orcad-source-destination-rows'
import {
  orcadMigrationOwnerMatchesScope,
  unqualifyOrcadMigrationOwnerKey,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'

/** Moves with its child alone; malformed rows stay in the retained source profile. */
export function collectOrcadMigrationCrossStoreLineage(
  state: PersistedState,
  scope: OrcadMigrationSourceScope,
  onDuplicate: () => void
): OrcadMigrationDormantCrossStoreLineage[] {
  const rows = Object.entries(state.crossStoreLineageByChildKey ?? {}).flatMap(
    ([sourceKey, lineage]) => {
      const childWorkspaceKey = unqualifyOrcadMigrationOwnerKey(sourceKey)
      return orcadMigrationOwnerMatchesScope(sourceKey, scope) &&
        isCrossStoreWorkspaceLineage(lineage) &&
        childWorkspaceKey === lineage.childWorkspaceKey
        ? [{ sourceKey, childWorkspaceKey, lineage: structuredClone(lineage) }]
        : []
    }
  )
  return uniqueDestinationRows(rows, (entry) => entry.childWorkspaceKey, onDuplicate).sort(
    (left, right) => compareKeys(left.childWorkspaceKey, right.childWorkspaceKey)
  )
}
