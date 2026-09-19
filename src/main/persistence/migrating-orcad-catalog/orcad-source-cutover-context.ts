import type { ProjectCollectionOperations } from '../loading-store/project-collection-operations'
import type { RepoLifecycleOperations } from '../loading-store/repo-lifecycle-operations'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import type { WriteSchedulingOperations } from '../loading-store/write-scheduling'
import type {
  OrcadMigrationManifestSource,
  OrcadMigrationCatalogPayload
} from '../../../shared/orcad-migration-manifest'

export type OrcadSourceLiveProjection = (
  state: StoreRuntimeState['state'],
  source: OrcadMigrationManifestSource,
  catalog: OrcadMigrationCatalogPayload
) => StoreRuntimeState['state']

export type OrcadSourceCutoverRuntime = Pick<
  StoreRuntimeState,
  'state' | 'terminalScrollbackSnapshotStorage'
>

export type OrcadSourceCutoverContext = {
  runtime: OrcadSourceCutoverRuntime
  projects: ProjectCollectionOperations
  repos: RepoLifecycleOperations
  scheduling: WriteSchedulingOperations
}
