import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS } from '../../../shared/pty-ownership-transfer-destination-adapter'
import {
  parsePtyOwnershipTransferDestinationFile,
  readPtyOwnershipTransferDestinationFile
} from '../pty-ownership-transfer/pty-ownership-transfer-destination-file'
import { ptyOwnershipTransferDestinationDirectory } from '../pty-ownership-transfer/pty-ownership-transfer-destination-file-store-contract'
import { resolveOrcadTerminalLayoutReservation } from '../migrating-orcad-catalog/orcad-terminal-layout-reservation'
import {
  ownershipTransferSurfaceSnapshotRef,
  ownershipTransferSurfaceModelSnapshotRef
} from '../pty-ownership-transfer/pty-ownership-transfer-snapshot-reference'
import { readTerminalScrollbackStoredBytesSync } from '../../terminal-scrollback-snapshots'
import { terminalScrollbackStoredBytesEqualSync } from '../../terminal-scrollback-durable-artifact'
import { inspectReservedPtyOwnershipTransferLayoutAdmission } from './pty-ownership-transfer-reserved-layout-admission'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

type Publication = Parameters<typeof resolveOrcadTerminalLayoutReservation>[1]

/** Fresh host evidence for mutation admission; the retention cache cannot authorize publication. */
export function inspectPtyOwnershipTransferCatalogSurface(
  runtime: Pick<StoreRuntimeState, 'dataFile' | 'state' | 'terminalScrollbackSnapshotStorage'>,
  session: WorkspaceSessionState,
  request: Publication
) {
  const directory = ptyOwnershipTransferDestinationDirectory(dirname(runtime.dataFile))
  const read = (bridgeId: string) => {
    const file = join(directory, `${createHash('sha256').update(bridgeId).digest('hex')}.json`)
    return parsePtyOwnershipTransferDestinationFile(
      readPtyOwnershipTransferDestinationFile(file),
      PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS
    )
  }
  let record: ReturnType<typeof read>
  try {
    record = read(request.identity.bridgeId)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
  const reservation = resolveOrcadTerminalLayoutReservation(record, request)
  if (!reservation) {
    return null
  }
  const manifest = record.catalogAdmission!.manifest
  const staged = runtime.state.orcadMigrationStagedCatalogs?.find(
    (entry) => entry.manifest.migrationId === manifest.migrationId
  )
  const committed = runtime.state.orcadMigrationImportReceipts?.find(
    (entry) => entry.migrationId === manifest.migrationId
  )
  if (
    (!staged && !committed) ||
    (staged && staged.manifest.manifestSha256 !== manifest.manifestSha256) ||
    (committed && committed.manifestSha256 !== manifest.manifestSha256)
  ) {
    throw new Error('pty_ownership_transfer_catalog_surface_authority_missing')
  }
  const requested = reservation.bindings.find(
    (entry) => entry.leafId === request.surfaceBinding.leafId
  )!
  const state = inspectReservedPtyOwnershipTransferLayoutAdmission(session, requested, reservation)
  if (state === 'conflict') {
    throw new Error('pty_ownership_transfer_catalog_surface_conflict')
  }
  const layout = session.terminalLayoutsByTabId[reservation.tab.id]
  for (const entry of record.catalogAdmission!.bindings) {
    if (layout?.ptyIdsByLeafId?.[entry.surfaceBinding.leafId] === undefined) {
      continue
    }
    const sibling = read(entry.identity.bridgeId)
    if (
      !sibling.publicationIntent ||
      serializeOrcadMigrationValue(sibling.catalogAdmission) !==
        serializeOrcadMigrationValue(record.catalogAdmission)
    ) {
      throw new Error('pty_ownership_transfer_catalog_surface_sibling_unverifiable')
    }
    const evidence = { ...entry, publicationReceipt: sibling.publicationIntent }
    resolveOrcadTerminalLayoutReservation(sibling, evidence)
    const ref = layout.scrollbackRefsByLeafId?.[entry.surfaceBinding.leafId]
    if (
      !ref ||
      (ref !== ownershipTransferSurfaceSnapshotRef(evidence) &&
        ref !== ownershipTransferSurfaceModelSnapshotRef(evidence)) ||
      (readTerminalScrollbackStoredBytesSync(ref, runtime.terminalScrollbackSnapshotStorage) ===
        null &&
        !terminalScrollbackStoredBytesEqualSync(ref, '', runtime.terminalScrollbackSnapshotStorage))
    ) {
      throw new Error('pty_ownership_transfer_catalog_surface_history_unverifiable')
    }
  }
  return { reservation, state }
}
