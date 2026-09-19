import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import type { Store } from '../persistence'
import type { OrcadMigrationSourceReleaseEvidence } from '../persistence/migrating-orcad-catalog/orcad-source-cutover'
import {
  abortRemoteOrcadMigrationCatalog,
  commitRemoteOrcadMigrationCatalog,
  readRemoteOrcadMigrationCatalogState,
  stageRemoteOrcadMigrationCatalog,
  stageRemoteOrcadMigrationSnapshotChunk
} from './orcad-migration-catalog-client'
import { transferOrcadMigrationSnapshots } from './orcad-migration-snapshot-coordinator'
import { resolveDurableOrcadCatalogMutation } from './orcad-catalog-durable-mutation'

export type SourceCutoverStore = Pick<
  Store,
  | 'assertOrcadMigrationSourceDependenciesAbsent'
  | 'assertOrcadMigrationSourceCatalogUnchanged'
  | 'beginOrcadMigrationSourceCutover'
  | 'flushPendingOrThrowAsync'
  | 'getOrcadMigrationSourceCutover'
  | 'markOrcadMigrationDestinationCommitted'
  | 'markOrcadMigrationDestinationStaged'
  | 'readOrcadMigrationSourceSnapshotChunk'
  | 'releaseOrcadMigrationSourceCutover'
  | 'retireOrcadMigrationSourceCatalog'
>

type RemoteCatalogOperations = {
  abort: typeof abortRemoteOrcadMigrationCatalog
  commit: typeof commitRemoteOrcadMigrationCatalog
  read: typeof readRemoteOrcadMigrationCatalogState
  snapshot: typeof stageRemoteOrcadMigrationSnapshotChunk
  stage: typeof stageRemoteOrcadMigrationCatalog
}

const REMOTE_CATALOG_OPERATIONS: RemoteCatalogOperations = {
  abort: abortRemoteOrcadMigrationCatalog,
  commit: commitRemoteOrcadMigrationCatalog,
  read: readRemoteOrcadMigrationCatalogState,
  snapshot: stageRemoteOrcadMigrationSnapshotChunk,
  stage: stageRemoteOrcadMigrationCatalog
}

type CutoverOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  remote?: RemoteCatalogOperations
}

export async function beginOrcadMigrationSourceCutoverDurably(args: {
  store: SourceCutoverStore
  manifest: OrcadMigrationManifest
  destinationEnvironmentId: string
  destinationName?: string
  signal?: AbortSignal
  now?: () => Date
}): Promise<OrcadMigrationSourceCutover> {
  const cutover = args.store.beginOrcadMigrationSourceCutover(
    args.manifest,
    args.destinationEnvironmentId,
    { destinationName: args.destinationName, now: args.now }
  )
  await flushSourceCutover(args.store, args.signal)
  return cutover
}

export async function stageOrcadMigrationDestination(args: {
  store: SourceCutoverStore
  migrationId: string
  pairingCode: string
  options?: CutoverOptions
}): Promise<OrcadMigrationSourceCutover> {
  const cutover = requireCutover(args.store, args.migrationId)
  if (cutover.phase === 'source-retired') {
    return cutover
  }
  args.store.assertOrcadMigrationSourceCatalogUnchanged(args.migrationId)
  args.store.assertOrcadMigrationSourceDependenciesAbsent(args.migrationId)
  await flushSourceCutover(args.store, args.options?.signal)
  const remote = args.options?.remote ?? REMOTE_CATALOG_OPERATIONS
  const requestOptions = remoteRequestOptions(args.options)
  let state = await remote.read(args.pairingCode, cutover.manifest, requestOptions)
  if (state.state !== 'committed') {
    state = await resolveDurableOrcadCatalogMutation(
      () => remote.stage(args.pairingCode, cutover.manifest, requestOptions),
      () => remote.read(args.pairingCode, cutover.manifest, requestOptions),
      (observed) => observed.state !== 'absent'
    )
  }
  if (state.state === 'committed') {
    state = await resolveDurableOrcadCatalogMutation(
      () => remote.commit(args.pairingCode, cutover.manifest, requestOptions),
      () => remote.read(args.pairingCode, cutover.manifest, requestOptions),
      (observed) => observed.state === 'committed'
    )
  }
  const persisted = await persistObservedDestinationState(
    args.store,
    args.migrationId,
    state,
    args.options?.signal
  )
  if (state.state === 'staged') {
    await transferOrcadMigrationSnapshots({
      store: args.store,
      cutover: persisted,
      pairingCode: args.pairingCode,
      state,
      remote,
      requestOptions
    })
  }
  return persisted
}

export async function commitOrcadMigrationDestination(args: {
  store: SourceCutoverStore
  migrationId: string
  pairingCode: string
  options?: CutoverOptions
}): Promise<OrcadMigrationSourceCutover> {
  const staged = await stageOrcadMigrationDestination(args)
  if (staged.phase === 'destination-committed' || staged.phase === 'source-retired') {
    return staged
  }
  args.store.assertOrcadMigrationSourceCatalogUnchanged(args.migrationId)
  args.store.assertOrcadMigrationSourceDependenciesAbsent(args.migrationId)
  await flushSourceCutover(args.store, args.options?.signal)
  const remote = args.options?.remote ?? REMOTE_CATALOG_OPERATIONS
  const requestOptions = remoteRequestOptions(args.options)
  const state = await resolveDurableOrcadCatalogMutation(
    () => remote.commit(args.pairingCode, staged.manifest, requestOptions),
    () => remote.read(args.pairingCode, staged.manifest, requestOptions),
    (observed) => observed.state === 'committed'
  )
  if (state.state !== 'committed') {
    throw new Error(`orcad_migration_commit_not_committed:${state.state}`)
  }
  const committed = args.store.markOrcadMigrationDestinationCommitted(args.migrationId, state)
  await flushSourceCutover(args.store, args.options?.signal)
  args.store.assertOrcadMigrationSourceCatalogUnchanged(args.migrationId)
  return committed
}

export async function retireOrcadMigrationSourceCatalogDurably(args: {
  store: SourceCutoverStore
  migrationId: string
  signal?: AbortSignal
  now?: () => Date
}): Promise<OrcadMigrationSourceCutover> {
  const retired = args.store.retireOrcadMigrationSourceCatalog(args.migrationId, {
    now: args.now
  })
  await flushSourceCutover(args.store, args.signal)
  return retired
}

export async function abortOrcadMigrationCutover(args: {
  store: SourceCutoverStore
  migrationId: string
  pairingCode: string
  options?: CutoverOptions
}): Promise<void> {
  const cutover = requireCutover(args.store, args.migrationId)
  await flushSourceCutover(args.store, args.options?.signal)
  const remote = args.options?.remote ?? REMOTE_CATALOG_OPERATIONS
  const requestOptions = remoteRequestOptions(args.options)
  let state: OrcadMigrationCatalogState
  try {
    state = await remote.read(args.pairingCode, cutover.manifest, requestOptions)
  } catch (error) {
    if (!isMethodUnsupported(error)) {
      throw error
    }
    await releaseSourceCutoverDurably(
      args.store,
      args.migrationId,
      { kind: 'stage-method-unsupported' },
      args.options?.signal
    )
    return
  }
  if (state.state === 'committed') {
    await persistObservedDestinationState(args.store, args.migrationId, state, args.options?.signal)
    throw new Error('orcad_migration_committed_source_cannot_be_released')
  }
  if (state.state === 'staged' || state.state === 'absent') {
    const result = await resolveAbortResponse(
      () => remote.abort(args.pairingCode, cutover.manifest, requestOptions),
      () => remote.read(args.pairingCode, cutover.manifest, requestOptions)
    )
    state = result
    if (state.state === 'committed') {
      await persistObservedDestinationState(
        args.store,
        args.migrationId,
        state,
        args.options?.signal
      )
      throw new Error('orcad_migration_committed_source_cannot_be_released')
    }
  }
  if (state.state !== 'absent') {
    throw new Error(`orcad_migration_abort_not_absent:${state.state}`)
  }
  await releaseSourceCutoverDurably(
    args.store,
    args.migrationId,
    { kind: 'catalog-absent', state },
    args.options?.signal
  )
}

async function persistObservedDestinationState(
  store: SourceCutoverStore,
  migrationId: string,
  state: OrcadMigrationCatalogState,
  signal?: AbortSignal
): Promise<OrcadMigrationSourceCutover> {
  if (state.state === 'absent') {
    throw new Error('orcad_migration_destination_catalog_absent')
  }
  const cutover =
    state.state === 'staged'
      ? store.markOrcadMigrationDestinationStaged(migrationId, state)
      : store.markOrcadMigrationDestinationCommitted(migrationId, state)
  await flushSourceCutover(store, signal)
  return cutover
}

async function releaseSourceCutoverDurably(
  store: SourceCutoverStore,
  migrationId: string,
  evidence: OrcadMigrationSourceReleaseEvidence,
  signal?: AbortSignal
): Promise<void> {
  store.releaseOrcadMigrationSourceCutover(migrationId, evidence)
  await flushSourceCutover(store, signal)
}

async function resolveAbortResponse(
  abort: () => Promise<OrcadMigrationCatalogAbortResult>,
  read: () => Promise<OrcadMigrationCatalogState>
): Promise<OrcadMigrationCatalogState> {
  try {
    return await abort()
  } catch (abortError) {
    try {
      const observed = await read()
      if (observed.state === 'committed') {
        return observed
      }
      if (observed.state === 'absent') {
        return await abort()
      }
    } catch {
      // The abort remains unverifiable; preserve its original failure and the source fence.
    }
    throw abortError
  }
}

function requireCutover(
  store: SourceCutoverStore,
  migrationId: string
): OrcadMigrationSourceCutover {
  const cutover = store.getOrcadMigrationSourceCutover(migrationId)
  if (!cutover) {
    throw new Error('orcad_migration_source_cutover_not_found')
  }
  return cutover
}

function flushSourceCutover(store: SourceCutoverStore, signal?: AbortSignal): Promise<void> {
  return store.flushPendingOrThrowAsync({ signal, drainToStableGeneration: false })
}

function remoteRequestOptions(options: CutoverOptions | undefined) {
  return { signal: options?.signal, timeoutMs: options?.timeoutMs }
}

function isMethodUnsupported(error: unknown): boolean {
  return error instanceof Error && /method(?:\s+|_)not(?:\s+|_)found/i.test(error.message)
}
