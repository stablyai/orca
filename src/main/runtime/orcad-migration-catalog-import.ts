import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationImportResult,
  OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import type { Store } from '../persistence'

type OrcadMigrationCatalogFlushStore = Pick<Store, 'flushPendingOrThrowAsync'>
type OrcadMigrationCatalogImportStore = OrcadMigrationCatalogFlushStore &
  Pick<Store, 'importOrcadMigrationCatalog'>
type OrcadMigrationCatalogStageStore = OrcadMigrationCatalogFlushStore &
  Pick<Store, 'stageOrcadMigrationCatalog'>
type OrcadMigrationCatalogCommitStore = OrcadMigrationCatalogFlushStore &
  Pick<Store, 'commitStagedOrcadMigrationCatalog'>
type OrcadMigrationCatalogAbortStore = OrcadMigrationCatalogFlushStore &
  Pick<Store, 'abortStagedOrcadMigrationCatalog'>

export async function importOrcadMigrationCatalogDurably(args: {
  store: OrcadMigrationCatalogImportStore
  manifest: OrcadMigrationManifest
  signal?: AbortSignal
  onDurableImport: () => void
}): Promise<OrcadMigrationImportResult> {
  const result = args.store.importOrcadMigrationCatalog(args.manifest)
  await args.store.flushPendingOrThrowAsync({
    signal: args.signal,
    drainToStableGeneration: false
  })
  args.onDurableImport()
  return result
}

export async function stageOrcadMigrationCatalogDurably(args: {
  store: OrcadMigrationCatalogStageStore
  manifest: OrcadMigrationManifest
  signal?: AbortSignal
}): Promise<OrcadMigrationCatalogState> {
  const result = args.store.stageOrcadMigrationCatalog(args.manifest)
  await flushMigrationState(args.store, args.signal)
  return result
}

export async function commitStagedOrcadMigrationCatalogDurably(args: {
  store: OrcadMigrationCatalogCommitStore
  manifest: OrcadMigrationManifest
  signal?: AbortSignal
  onDurableCommit: () => void
}): Promise<OrcadMigrationCatalogState> {
  const result = args.store.commitStagedOrcadMigrationCatalog(args.manifest)
  await flushMigrationState(args.store, args.signal)
  args.onDurableCommit()
  return result
}

export async function abortStagedOrcadMigrationCatalogDurably(args: {
  store: OrcadMigrationCatalogAbortStore
  manifest: OrcadMigrationManifest
  signal?: AbortSignal
}): Promise<OrcadMigrationCatalogAbortResult> {
  const result = args.store.abortStagedOrcadMigrationCatalog(args.manifest)
  // An already-absent retry may follow an in-memory abort whose flush failed.
  if (result.state === 'absent') {
    await flushMigrationState(args.store, args.signal)
    return { ...result, durableAbsent: true }
  }
  return result
}

export function getOrcadMigrationCatalogState(args: {
  store: Pick<Store, 'getOrcadMigrationCatalogState'>
  manifest: OrcadMigrationManifest
}): OrcadMigrationCatalogState {
  return args.store.getOrcadMigrationCatalogState(args.manifest)
}

function flushMigrationState(
  store: OrcadMigrationCatalogFlushStore,
  signal?: AbortSignal
): Promise<void> {
  return store.flushPendingOrThrowAsync({ signal, drainToStableGeneration: false })
}
