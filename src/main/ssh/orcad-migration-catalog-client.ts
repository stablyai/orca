import {
  parseOrcadMigrationCatalogAbortResult,
  parseOrcadMigrationCatalogState
} from '../../shared/orcad-migration-catalog-state'
import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import {
  parseOrcadMigrationSnapshotChunkResult,
  type OrcadMigrationSnapshotChunkRequest,
  type OrcadMigrationSnapshotChunkResult
} from '../../shared/orcad-migration-scrollback'
import { parsePairingCode } from '../../shared/pairing'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'

type OrcadCatalogMigrationOperation = 'abort' | 'commit' | 'stage' | 'state'

type CatalogRequestOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  expectedRuntimeId?: string
}

const METHOD_BY_OPERATION: Record<OrcadCatalogMigrationOperation, string> = {
  abort: 'orcad.migration.abortCatalog',
  commit: 'orcad.migration.commitCatalog',
  stage: 'orcad.migration.stageCatalog',
  state: 'orcad.migration.catalogState'
}

export function stageRemoteOrcadMigrationCatalog(
  pairingCode: string,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationCatalogState> {
  return requestCatalogState(pairingCode, 'stage', manifest, options)
}

export function commitRemoteOrcadMigrationCatalog(
  pairingCode: string,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationCatalogState> {
  return requestCatalogState(pairingCode, 'commit', manifest, options)
}

export function readRemoteOrcadMigrationCatalogState(
  pairingCode: string,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationCatalogState> {
  return requestCatalogState(pairingCode, 'state', manifest, options)
}

export async function abortRemoteOrcadMigrationCatalog(
  pairingCode: string,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationCatalogAbortResult> {
  const result = await request(pairingCode, 'abort', manifest, options)
  const parsed = parseOrcadMigrationCatalogAbortResult(result, manifest)
  // Older hosts flush real aborts, but their already-absent responses prove no persistence.
  if (parsed.state === 'absent' && !parsed.aborted && parsed.durableAbsent !== true) {
    throw new Error('orcad_migration_abort_durability_unverifiable:destination_update_required')
  }
  return parsed
}

export async function stageRemoteOrcadMigrationSnapshotChunk(
  pairingCode: string,
  request: OrcadMigrationSnapshotChunkRequest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationSnapshotChunkResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const response = await sendRemoteRuntimeRequest<unknown>(
    pairing,
    'orcad.migration.stageSnapshotChunk',
    request,
    options.timeoutMs ?? 15_000,
    undefined,
    options.signal,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  if (!response.ok) {
    throw new Error(`orcad_migration_snapshot_failed:${response.error.message}`)
  }
  if (
    options.expectedRuntimeId !== undefined &&
    response._meta?.runtimeId !== options.expectedRuntimeId
  ) {
    throw new Error('orcad_migration_destination_runtime_mismatch')
  }
  return parseOrcadMigrationSnapshotChunkResult(response.result, request)
}

async function requestCatalogState(
  pairingCode: string,
  operation: Exclude<OrcadCatalogMigrationOperation, 'abort'>,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions
): Promise<OrcadMigrationCatalogState> {
  const result = await request(pairingCode, operation, manifest, options)
  return parseOrcadMigrationCatalogState(result, manifest)
}

async function request(
  pairingCode: string,
  operation: OrcadCatalogMigrationOperation,
  manifest: OrcadMigrationManifest,
  options: CatalogRequestOptions
): Promise<unknown> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const response = await sendRemoteRuntimeRequest<unknown>(
    pairing,
    METHOD_BY_OPERATION[operation],
    { manifest },
    options.timeoutMs ?? 15_000,
    undefined,
    options.signal,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  if (!response.ok) {
    throw new Error(`orcad_migration_${operation}_failed:${response.error.message}`)
  }
  if (
    options.expectedRuntimeId !== undefined &&
    response._meta?.runtimeId !== options.expectedRuntimeId
  ) {
    throw new Error('orcad_migration_destination_runtime_mismatch')
  }
  return response.result
}
