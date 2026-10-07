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
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY } from '../../shared/orcad-runtime-capabilities'
import { sendRemoteRuntimeRequestWithStatusPreflight } from '../../shared/remote-runtime-client'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

type OrcadCatalogMigrationOperation = 'abort' | 'commit' | 'stage' | 'state'

/**
 * A destination that does not offer catalog migration: an older orcad without the capability or
 * the method. This is a definite refusal; any other failure, including a lost answer, is not, and
 * the caller re-reads the catalog state before deciding anything.
 */
export const ORCAD_MIGRATION_DESTINATION_UNSUPPORTED = 'orcad_migration_destination_unsupported'

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
  const response = await sendSupportedMigrationRequest(
    pairing,
    'orcad.migration.stageSnapshotChunk',
    request,
    options
  )
  if (!response.ok) {
    throw new Error(`orcad_migration_snapshot_failed:${response.error.message}`)
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
  const response = await sendSupportedMigrationRequest(
    pairing,
    METHOD_BY_OPERATION[operation],
    { manifest },
    options
  )
  if (!response.ok) {
    throw new Error(`orcad_migration_${operation}_failed:${response.error.message}`)
  }
  return response.result
}

async function sendSupportedMigrationRequest(
  pairing: NonNullable<ReturnType<typeof parsePairingCode>>,
  method: string,
  params: unknown,
  options: CatalogRequestOptions
): Promise<RuntimeRpcResponse<unknown>> {
  const response = await sendRemoteRuntimeRequestWithStatusPreflight<unknown>(
    pairing,
    method,
    params,
    options.timeoutMs ?? 15_000,
    (status) => {
      if (!status.ok) {
        throw new Error(`orcad_migration_status_failed:${status.error.message}`)
      }
      if (
        options.expectedRuntimeId !== undefined &&
        status._meta?.runtimeId !== options.expectedRuntimeId
      ) {
        throw new Error('orcad_migration_destination_runtime_mismatch')
      }
      if (!status.result.capabilities?.includes(ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY)) {
        throw new Error(ORCAD_MIGRATION_DESTINATION_UNSUPPORTED)
      }
    },
    undefined,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
    options.signal
  )
  if (!response.ok && response.error.code === 'method_not_found') {
    throw new Error(ORCAD_MIGRATION_DESTINATION_UNSUPPORTED)
  }
  if (
    options.expectedRuntimeId !== undefined &&
    response._meta?.runtimeId !== options.expectedRuntimeId
  ) {
    throw new Error('orcad_migration_destination_runtime_mismatch')
  }
  return response
}
